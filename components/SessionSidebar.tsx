"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type UIEvent as ReactUIEvent } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies, type SessionFamily } from "@/lib/session-family";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { getProjectActivity, getRecentProjects } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import {
  buildArchiveRows,
  buildSessionTree,
  familiesToArchive,
  familyIds,
  isFamilyArchived,
  isGroupExpanded,
  keepOutgoingGroupOpen,
  showLessFamilies,
  showMoreFamilies,
  projectNameOf,
  type SidebarProject,
  type SidebarRow,
} from "@/lib/session-tree";
import {
  forgetRetiredSidebarKeys,
  loadGroupExpansion,
  loadPinnedCollapsed,
  loadSidebarTab,
  saveGroupExpansion,
  savePinnedCollapsed,
  saveSidebarTab,
  type SidebarTab,
} from "@/lib/sidebar-prefs";
import {
  needsWorktreePicker,
  parseWorktreeListing,
  pickerCurrentWorktreePath,
  sessionMenuEntries,
  type SessionMenuActionId,
  type WorktreeListing,
} from "@/lib/sidebar-actions";
import { chunkForSessionUiRequests, type SessionUiStateRequest } from "@/lib/session-ui-state-shared";
import { focusIfLost } from "@/lib/stacked-dialog";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { useSessionUiState } from "@/hooks/useSessionUiState";
import { DirectoryPicker } from "./DirectoryPicker";
import { DismissButton } from "./DismissButton";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SessionSearch } from "./SessionSearch";
import { SessionTree, sessionRowTitle } from "./SessionTree";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";
import { SidebarToast, type SidebarToastAction, type SidebarToastData } from "./SidebarToast";
import {
  ArchiveIcon,
  BranchIcon,
  ChangesIcon,
  CheckIcon,
  ChevronIcon,
  DotIcon,
  DotOutlineIcon,
  FolderIcon,
  MoreIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshIcon,
  RestoreIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  UploadIcon,
} from "./SidebarIcons";

interface FileManagerAvailability {
  supported: boolean;
  reason: string | null;
  platform: string;
}

// Server error codes with a translation; any other code is shown verbatim.
const FILE_MANAGER_ERROR_KEYS: Record<string, string> = {
  remote: "sidebar.openInExplorerRemoteOnly",
  "unsupported-platform": "sidebar.openInExplorerUnsupported",
};

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

/** A 26px icon button of the files tab's explorer toolbar. */
function ToolbarIconButton({
  onClick,
  title,
  disabled,
  pressed,
  done,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  /** A toggle's state: shown pressed (accent) and exposed as aria-pressed. */
  pressed?: boolean;
  /** Brief confirmation after an action (refresh). */
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      className={`sidebar-tool-button${pressed ? " is-active" : ""}${done ? " is-done" : ""}`}
    >
      {children}
    </button>
  );
}

function sessionListUrl(summary: boolean, force: boolean): string {
  if (summary) return "/api/sessions?summary=1";
  if (force) return "/api/sessions?force=1";
  return "/api/sessions";
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  /** projectKey: the target's project identity when it is known (a group's "+"). */
  onNewSession?: (sessionId: string, cwd: string, projectKey?: string | null) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

type SessionRow = Extract<SidebarRow, { kind: "session" }>;

/** Where a new session starts, from the header "+", a group's "+" or its worktree picker. */
interface NewSessionTarget {
  cwd: string;
  /** The target's project identity, handed to the shell so it adopts that project. */
  projectKey?: string;
  /** Server-resolved root of that identity (a worktree listing): installed before the cwd changes. */
  projectRoot?: string;
}

/** The one popup menu of the sidebar; kept here, above the virtualized rows. */
type SidebarMenuState =
  | { kind: "row"; row: SessionRow; anchor: SidebarMenuAnchor; opener: HTMLElement | null }
  | { kind: "group"; project: SidebarProject; olderCount: number; anchor: SidebarMenuAnchor; opener: HTMLElement }
  | {
      kind: "worktrees";
      project: SidebarProject;
      listing: WorktreeListing;
      anchor: SidebarMenuAnchor;
      opener: HTMLElement;
      /** Set while the menu shows the "new worktree" form instead of the list. */
      form: { busy: boolean; error: string | null } | null;
    }
  | { kind: "view"; anchor: SidebarMenuAnchor; opener: HTMLElement };

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;
const SESSION_DETAILS_HYDRATION_DELAY_MS = 750;
/** "Archive sessions older than 7 days" in a project's menu. */
const ARCHIVE_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;
const TOAST_TITLE_MAX = 28;

const SESSION_ACTION_LABEL_KEYS: Record<SessionMenuActionId, string> = {
  pin: "sidebar.pin",
  unpin: "sidebar.unpin",
  rename: "sidebar.rename",
  "mark-read": "sidebar.markRead",
  "mark-unread": "sidebar.markUnread",
  archive: "sidebar.archive",
  unarchive: "sidebar.unarchive",
  delete: "sidebar.delete",
};

function sessionActionIcon(id: SessionMenuActionId): ReactNode {
  switch (id) {
    case "pin": return <PinIcon />;
    case "unpin": return <PinOffIcon />;
    case "rename": return <PencilIcon />;
    case "mark-read": return <DotOutlineIcon />;
    case "mark-unread": return <DotIcon />;
    case "archive": return <ArchiveIcon />;
    case "unarchive": return <RestoreIcon />;
    case "delete": return <TrashIcon />;
  }
}

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/**
 * The running set for a polled id list: `previous` itself while it holds the
 * same ids. A new Set every 2.5 s poll would rebuild every tree row (memoized
 * by identity) and re-run everything that watches the set, for nothing.
 */
export function sameIdsOr(previous: Set<string>, ids: readonly string[]): Set<string> {
  const next = new Set(ids);
  if (next.size !== previous.size) return next;
  for (const id of next) {
    if (!previous.has(id)) return next;
  }
  return previous;
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/** Temporary id for a session that does not exist yet: pi is spawned lazily
 *  when the user sends the first message, so no backend call is needed. */
function createTempSessionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function shortTitle(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

/**
 * focusIfLost, also when focus is still on an element that is no longer
 * rendered (in a view just hidden): browsers move it to <body> only at their
 * next rendering update, so it does not count as lost yet.
 */
function focusIfHidden(target: HTMLElement | null): void {
  const active = document.activeElement;
  if (target && active instanceof HTMLElement && active !== document.body && active.getClientRects().length === 0) {
    target.focus({ preventScroll: true });
    return;
  }
  focusIfLost(document, target);
}

/** A menu placed below (or above) a button, lined up with one of its edges. */
function buttonAnchor(element: HTMLElement, align: "start" | "end"): SidebarMenuAnchor {
  const rect = element.getBoundingClientRect();
  return { kind: "rect", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, align };
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, className, style }: { text: string; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={className}
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

/** Shared look of the project and worktree dropdowns. */
const DROPDOWN_STYLE: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 8,
  right: 8,
  zIndex: 100,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
  overflow: "hidden",
};

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

/**
 * The worktree picker's "New worktree…" body: a branch name and Create. On a
 * phone the sheet brings its own Cancel and title.
 */
function WorktreeCreateForm({
  heading,
  busy,
  error,
  showCancel,
  onCreate,
  onCancel,
}: {
  heading: string | null;
  busy: boolean;
  error: string | null;
  showCancel: boolean;
  onCreate: (branch: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [branch, setBranch] = useState("");
  const trimmed = branch.trim();
  const submit = () => {
    if (trimmed && !busy) onCreate(trimmed);
  };
  return (
    <div className="sidebar-worktree-form">
      {heading && <div className="sidebar-menu-header">{heading}</div>}
      <input
        className="sidebar-worktree-input"
        value={branch}
        readOnly={busy}
        placeholder={t("sidebar.branchName")}
        aria-label={t("sidebar.branchName")}
        onChange={(event) => setBranch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          submit();
        }}
      />
      <div className="sidebar-worktree-form-buttons">
        <button type="button" className="sidebar-worktree-create" disabled={busy || !trimmed} onClick={submit}>
          {busy ? t("sidebar.creating") : t("sidebar.create")}
        </button>
        {showCancel && (
          <button type="button" className="sidebar-worktree-cancel" onClick={onCancel}>
            {t("sidebar.cancel")}
          </button>
        )}
      </div>
      {error && <div className="sidebar-worktree-error" role="alert">{error}</div>}
    </div>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  // Tracked in a ref only: the version is compared against the polled value to
  // decide whether the list needs reloading, and no render reads it.
  const sessionListVersionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const projectButtonRef = useRef<HTMLButtonElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [fileManager, setFileManager] = useState<FileManagerAvailability | null>(null);
  const [fileManagerError, setFileManagerError] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const detailsHydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Sessions | Files. Both panels stay mounted; only the active one is shown.
  // The tab, the group choices and the pinned section start as the server
  // renders them and are restored from browser storage after hydration.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("sessions");
  const sessionsTabRef = useRef<HTMLButtonElement>(null);
  const filesTabRef = useRef<HTMLButtonElement>(null);
  const sessionsPanelRef = useRef<HTMLDivElement>(null);
  const filesPanelRef = useRef<HTMLDivElement>(null);
  const panelScrollTopsRef = useRef(new WeakMap<Element, number>());
  // Project groups: explicit expand/collapse choices, how many families "show
  // more" has revealed per group (SHOW_MORE_STEP a click), the pinned section,
  // the archive view.
  const [groupExpansion, setGroupExpansion] = useState<Readonly<Record<string, boolean>>>({});
  const [moreShown, setMoreShown] = useState<Readonly<Record<string, number>>>({});
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [archiveView, setArchiveView] = useState(false);
  // Row states that must survive virtualization live here, not in the rows.
  const [renamingRootId, setRenamingRootId] = useState<string | null>(null);
  const [confirmDeleteRootId, setConfirmDeleteRootId] = useState<string | null>(null);
  const [menu, setMenu] = useState<SidebarMenuState | null>(null);
  const menuRef = useRef<SidebarMenuState | null>(null);
  menuRef.current = menu;
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  // A group "+" waiting for its project's worktree list.
  const [pendingGroupKey, setPendingGroupKey] = useState<string | null>(null);
  const groupNewRequestRef = useRef(0);
  const [toast, setToast] = useState<SidebarToastData | null>(null);
  const toastIdRef = useRef(0);
  const [uiWriteFailures, setUiWriteFailures] = useState(0);
  const shownUiWriteFailuresRef = useRef(0);
  // Focus to hand to the files tab once it shows (the control that moved
  // there was in the sessions tab, which hides with its focus).
  const filesTabFocusRef = useRef<"project-button" | "project-list" | null>(null);
  const contextMenuFocusRef = useRef<HTMLElement | null>(null);

  // A group's "+" waits for its project's worktree list. Anything the user
  // does meanwhile (a session or project picked, another new session, a menu
  // or picker opened) cancels it: a late answer must not start a session, or
  // open the worktree picker, over wherever they went.
  const cancelGroupNew = useCallback(() => {
    groupNewRequestRef.current += 1;
    setPendingGroupKey(null);
  }, []);
  useEffect(() => {
    cancelGroupNew();
  }, [selectedSessionId, selectedCwd, cancelGroupNew]);
  useEffect(() => {
    if (menu !== null) cancelGroupNew();
  }, [menu, cancelGroupNew]);
  useEffect(() => {
    if (dropdownOpen || wtDropdownOpen || customPathOpen) cancelGroupNew();
  }, [dropdownOpen, wtDropdownOpen, customPathOpen, cancelGroupNew]);

  // Pins and archive: pi-web's own state, kept on the server for every window.
  const {
    state: uiState,
    loaded: uiStateLoaded,
    error: uiStateError,
    apply: applyUiStateRequest,
    snapshot: snapshotUiState,
    noteRevision: noteUiRevision,
  } = useSessionUiState();

  // The explorer's scroll container is always mounted (empty without a cwd),
  // so the scrollbar hook stays bound to the element that is on the page.
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  useScrollbarVisibility(explorerScrollRef);

  // Browser storage is unavailable during server rendering. Restore the
  // sidebar preferences after hydration: read in a state initializer, a saved
  // Files tab would make the first client render differ from the server's
  // HTML (a hydration error, and the server markup thrown away).
  useEffect(() => {
    const tab = loadSidebarTab();
    if (tab !== "sessions") setSidebarTab(tab);
    const groups = loadGroupExpansion();
    if (Object.keys(groups).length > 0) setGroupExpansion(groups);
    if (loadPinnedCollapsed()) setPinnedCollapsed(true);
    forgetRetiredSidebarKeys();
  }, []);

  const loadSessions = useCallback(async (showLoading = false, force = false, summary = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(sessionListUrl(summary, force), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds((previous) => sameIdsOr(previous, data.runningSessionIds ?? []));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    let active = true;

    if (isFirst) {
      // Header/stat metadata is enough to select the URL session and paint the
      // sidebar. Hydrate exact counts, names, and first messages once the
      // selected chat has had a chance to start loading.
      void loadSessions(true, false, true).then(() => {
        if (!active) return;
        detailsHydrationTimerRef.current = setTimeout(() => {
          detailsHydrationTimerRef.current = null;
          if (active) void loadSessions(false, true);
        }, SESSION_DETAILS_HYDRATION_DELAY_MS);
      });
    } else {
      void loadSessions(false, true);
    }

    return () => {
      active = false;
      if (detailsHydrationTimerRef.current) {
        clearTimeout(detailsHydrationTimerRef.current);
        detailsHydrationTimerRef.current = null;
      }
    };
  }, [loadSessions, refreshKey]);

  // Only the server can raise a file-manager window, and only when the browser
  // runs on that same machine. Ask it once so the button can pick the right
  // label (Explorer / Finder / generic) and disable itself when unavailable.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/open-in-explorer")
      .then((res) => res.ok ? res.json() as Promise<FileManagerAvailability> : null)
      .then((data) => { if (!cancelled && data) setFileManager(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // A failure belongs to the project it happened on.
  useEffect(() => {
    setFileManagerError(null);
  }, [selectedCwd, selectedCwdProp]);

  const openInFileManager = useCallback(async () => {
    const dir = selectedCwd ?? selectedCwdProp;
    if (!dir) return;
    try {
      const res = await fetch("/api/open-in-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: dir }),
      });
      if (res.ok) {
        setFileManagerError(null);
        return;
      }
      const data = await res.json().catch(() => ({})) as { error?: string };
      setFileManagerError(data.error ?? `HTTP ${res.status}`);
    } catch (error) {
      setFileManagerError(error instanceof Error ? error.message : String(error));
    }
  }, [selectedCwd, selectedCwdProp]);

  const fileManagerLabel = t(
    fileManager?.platform === "darwin"
      ? "sidebar.openInFinder"
      : fileManager?.platform === "win32"
        ? "sidebar.openInExplorer"
        : "sidebar.openInFileManager",
  );
  const fileManagerUnavailable = fileManager?.supported === false;
  const fileManagerErrorMessage = fileManagerError
    ? t(FILE_MANAGER_ERROR_KEYS[fileManagerError] ?? fileManagerError)
    : null;

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          sessionListVersion: number;
          runningSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
          sessionUiStateRevision?: number | null;
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds((previous) => sameIdsOr(previous, data.runningSessionIds ?? []));
        // Pins and archive changed in another window: reload them.
        noteUiRevision(data.sessionUiStateRevision);
        if (data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSessions, noteUiRevision]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // The project of the sidebar's cwd: the files tab shows it, and its group in
  // the sessions tab exists even before it has a session.
  const selectedProject = useMemo(() => projectFor(selectedCwd), [projectFor, selectedCwd]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one group, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back. The prop
  // goes null when the shell switches project from here; forgetting the last
  // value then lets a restored session in a worktree that was synced before
  // move the cwd again, so the files tab shows the checkout the chat uses.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedCwdProp) {
      lastSyncedCwdPropRef.current = null;
      return;
    }
    if (selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string, { remember = true } = {}) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      if (remember) {
        saveLastCustomCwd(data.cwd);
        setCustomPathValue(data.cwd);
      }
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      // Select it like any other directory, so validation, project identity and
      // the file allow-list all go through /api/cwd/validate. It is not a path
      // the user typed, so the custom-path picker does not remember it.
      if (data.cwd) await commitCustomPath(data.cwd, { remember: false });
    } catch {
      // ignore
    }
  }, [commitCustomPath]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    cancelGroupNew();
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId, blockIndex);
  }, [cancelGroupNew, onSelectSession]);

  // Every "new session" goes through here. The cwd moves first, on the click
  // path like a session pick, and the shell gets the target's project so it
  // adopts it up front: a session in another project closes the previous
  // project's file tabs instead of being mistaken for identity hydration.
  const startNewSessionIn = useCallback(({ cwd, projectKey, projectRoot }: NewSessionTarget) => {
    cancelGroupNew();
    // A worktree without sessions has no other source of identity yet.
    if (projectKey && projectRoot) setValidatedProject({ cwd, root: projectRoot, key: projectKey });
    setSelectedCwd(cwd);
    onNewSession?.(createTempSessionId(), cwd, projectKey);
  }, [cancelGroupNew, onNewSession]);
  // A group's "+" answers later: it starts the session with the newest closure.
  const startNewSessionInRef = useRef(startNewSessionIn);
  startNewSessionInRef.current = startNewSessionIn;

  // Header "+": a new session in the sidebar's current cwd (worktree).
  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    startNewSessionIn({ cwd: selectedCwd });
  }, [selectedCwd, startNewSessionIn]);

  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase();
    return query
      ? recentProjects.filter((project) => project.root.toLowerCase().includes(query))
      : recentProjects;
  }, [projectFilter, recentProjects]);

  const sessionFamilies = useMemo(() => listSessionFamilies(allSessions), [allSessions]);
  const familyByRootId = useMemo(
    () => new Map(sessionFamilies.map((family) => [family.root.id, family])),
    [sessionFamilies],
  );

  // Every session id of an archived family (search tags them), and how many
  // families each project has in the archive.
  const archiveIndex = useMemo(() => {
    const ids = new Set<string>();
    const countByProject = new Map<string, number>();
    for (const family of sessionFamilies) {
      if (!isFamilyArchived(family, uiState, runningSessionIds)) continue;
      for (const id of familyIds(family)) ids.add(id);
      const key = workspaceKeyOf(family.root);
      countByProject.set(key, (countByProject.get(key) ?? 0) + 1);
    }
    return { ids, countByProject };
  }, [sessionFamilies, uiState, runningSessionIds]);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering. An
  // archived family is out of sight, so it does not count as activity.
  const projectActivity = useMemo(
    () => getProjectActivity(
      archiveIndex.ids.size === 0 ? allSessions : allSessions.filter((session) => !archiveIndex.ids.has(session.id)),
      runningSessionIds,
      unreadSessionIds,
    ),
    [allSessions, archiveIndex, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  // The tree of every project. Its group for the current project exists even
  // without sessions (a fresh custom path, a new worktree).
  const currentProjectKey = selectedProject?.key ?? null;
  const currentProjectRoot = selectedProject?.root ?? null;
  const currentProject = useMemo(
    () => (currentProjectKey && currentProjectRoot ? { key: currentProjectKey, root: currentProjectRoot } : null),
    [currentProjectKey, currentProjectRoot],
  );
  const model = useMemo(() => buildSessionTree({
    sessions: allSessions,
    uiState,
    runningIds: runningSessionIds,
    unreadIds: unreadSessionIds,
    selectedSessionId,
    currentProject,
    groupExpansion,
    moreShown,
    pinnedCollapsed,
  }), [allSessions, uiState, runningSessionIds, unreadSessionIds, selectedSessionId, currentProject, groupExpansion, moreShown, pinnedCollapsed]);
  const archiveRows = useMemo(() => (archiveView ? buildArchiveRows({
    sessions: allSessions,
    uiState,
    runningIds: runningSessionIds,
    unreadIds: unreadSessionIds,
    selectedSessionId,
    currentProject,
  }) : []), [archiveView, allSessions, uiState, runningSessionIds, unreadSessionIds, selectedSessionId, currentProject]);
  const projectByKey = useMemo(
    () => new Map(model.projects.map((project) => [project.key, project])),
    [model.projects],
  );

  // Picking a session in another group makes its project current. The group
  // that was current keeps its look instead of folding up under the pointer
  // (keepOutgoingGroupOpen), before the browser paints the change.
  const previousCurrentProjectKeyRef = useRef(currentProjectKey);
  useLayoutEffect(() => {
    const previous = previousCurrentProjectKeyRef.current;
    previousCurrentProjectKeyRef.current = currentProjectKey;
    if (previous === null || previous === currentProjectKey) return;
    const next = keepOutgoingGroupOpen(groupExpansion, projectByKey.get(previous));
    if (next === groupExpansion) return;
    setGroupExpansion(next);
    saveGroupExpansion(next);
  }, [currentProjectKey, groupExpansion, projectByKey]);

  const showToast = useCallback((message: string, actions: SidebarToastAction[] = []) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message, actions });
  }, []);

  // Focus to settle once a change is on the page, after the control that had
  // it went away with that change (a toast's button, a delete confirmation's
  // Cancel). Only focus that fell to <body> moves (focusIfLost): focus the
  // user put elsewhere stays.
  const focusAfterCommitRef = useRef<(() => HTMLElement | null) | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusAfterCommit = useCallback((target: () => HTMLElement | null) => {
    focusAfterCommitRef.current = target;
    setFocusRequest((count) => count + 1);
  }, []);
  useEffect(() => {
    const target = focusAfterCommitRef.current;
    focusAfterCommitRef.current = null;
    if (target) focusIfLost(document, target());
  }, [focusRequest]);

  /** The selected tab: focus has somewhere to go when the control it was on is gone. */
  const selectedTabButton = useCallback(
    () => (sessionsPanelRef.current?.hidden ? filesTabRef : sessionsTabRef).current,
    [],
  );

  // A family's row where the tree shows it now (pinned, in its group, or in
  // the open archive view), else the selected tab.
  const familyRowButton = useCallback((rootId: string): HTMLElement | null => {
    const panel = sessionsPanelRef.current;
    for (const context of ["pinned", "group", "archive"]) {
      const key = CSS.escape(`session:${context}:${rootId}`);
      const button = panel?.querySelector<HTMLElement>(`[data-row-key="${key}"] .session-tree-main`);
      if (button && button.getClientRects().length > 0) return button;
    }
    return selectedTabButton();
  }, [selectedTabButton]);

  // Pin and archive changes apply at once and are saved in the background; a
  // refused save rolls back (useSessionUiState) and says why in a toast.
  const applyUiState = useCallback(async (request: SessionUiStateRequest) => {
    const ok = await applyUiStateRequest(request);
    if (!ok) setUiWriteFailures((count) => count + 1);
    return ok;
  }, [applyUiStateRequest]);
  useEffect(() => {
    if (uiWriteFailures === shownUiWriteFailuresRef.current) return;
    shownUiWriteFailuresRef.current = uiWriteFailures;
    showToast(t("sidebar.uiStateFailed", { error: uiStateError ?? "" }));
  }, [uiWriteFailures, uiStateError, showToast, t]);

  const switchTab = useCallback((tab: SidebarTab) => {
    setSidebarTab(tab);
    saveSidebarTab(tab);
  }, []);

  // A hidden panel is display: none, and browsers do not reliably keep the
  // scroll position of what it holds. Positions are noted as the user
  // scrolls and put back when the panel (or the tree under the archive
  // view) shows again; SessionTree then re-reads its window from them.
  const rememberScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element) panelScrollTopsRef.current.set(target, target.scrollTop);
  }, []);
  useLayoutEffect(() => {
    const panel = (sidebarTab === "sessions" ? sessionsPanelRef : filesPanelRef).current;
    if (!panel) return;
    for (const element of panel.querySelectorAll<HTMLElement>(".session-tree-scroll, .sidebar-files-scroll")) {
      const saved = panelScrollTopsRef.current.get(element);
      if (saved !== undefined && element.scrollTop !== saved) element.scrollTop = saved;
    }
  }, [sidebarTab, archiveView]);

  const openArchiveView = useCallback(() => {
    setMenu(null);
    setArchiveView(true);
    // Search results would cover it.
    setSessionSearchOpen(false);
    switchTab("sessions");
  }, [switchTab]);

  // Opening the archive hides the tree that held focus (the footer link, a
  // menu's opener, the toast's View) and Back removes the archive's own
  // controls. Focus that went with them moves to the archive's Back button,
  // then back to the footer link, or to the tab when that row is not shown.
  const archiveBackRef = useRef<HTMLButtonElement>(null);
  const previousArchiveViewRef = useRef(archiveView);
  useEffect(() => {
    if (previousArchiveViewRef.current === archiveView) return;
    previousArchiveViewRef.current = archiveView;
    if (archiveView) {
      focusIfHidden(archiveBackRef.current);
      return;
    }
    const footer = sessionsPanelRef.current?.querySelector<HTMLElement>('[data-row-key="footer-archived"] button');
    focusIfHidden(footer && footer.getClientRects().length > 0 ? footer : selectedTabButton());
  }, [archiveView, selectedTabButton]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: SidebarTab = event.key === "Home" ? "sessions"
      : event.key === "End" ? "files"
      : sidebarTab === "sessions" ? "files" : "sessions";
    switchTab(next);
    (next === "sessions" ? sessionsTabRef : filesTabRef).current?.focus();
  };

  // A session family's pin and archive flags live on its root session.
  const setFamilyPinned = useCallback((family: SessionFamily, pinned: boolean) => {
    void applyUiState({ action: "set", ids: [family.root.id], pinned });
  }, [applyUiState]);

  const markFamilyRead = useCallback((family: SessionFamily, read: boolean) => {
    setUnreadSessionIds((prev) => {
      const next = new Set(prev);
      if (read) {
        for (const id of familyIds(family)) next.delete(id);
      } else {
        // Subagents never carry the marker (loadSessions prunes them).
        next.add(family.root.id);
      }
      return next;
    });
  }, []);

  // Unread markers coming back (Undo, a refused archive), except on the
  // session that is open by now: it has been read.
  const restoreUnread = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setUnreadSessionIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (id !== selectedSessionIdRef.current) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const archiveFamilies = useCallback((families: readonly SessionFamily[]) => {
    const archivable = families.filter((family) => !family.root.transient);
    if (archivable.length === 0) return;
    const snapshot = snapshotUiState(archivable.map((family) => family.root.id));
    // Archived means dealt with: its unread markers go, and Undo brings them back.
    const memberIds = archivable.flatMap((family) => familyIds(family));
    const unreadBefore = memberIds.filter((id) => unreadSessionIds.has(id));
    // A request carries at most MAX_SESSION_UI_IDS_PER_REQUEST families, so a
    // big "Archive sessions older than 7 days" goes in parts; the write queue
    // of useSessionUiState keeps them, and an Undo after them, in order.
    for (const part of chunkForSessionUiRequests(archivable)) {
      const ids = part.map((family) => family.root.id);
      void applyUiState({ action: "set", ids, archived: true }).then((ok) => {
        // A refused part is back in the tree (rolled back): so are its markers.
        if (ok || unreadBefore.length === 0) return;
        const partIds = new Set(part.flatMap((family) => familyIds(family)));
        restoreUnread(unreadBefore.filter((id) => partIds.has(id)));
      });
    }
    if (unreadBefore.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of memberIds) next.delete(id);
        return next;
      });
    }
    const message = archivable.length === 1
      ? t("sidebar.archivedToast", { title: shortTitle(sessionRowTitle(archivable[0].root), TOAST_TITLE_MAX) })
      : t("sidebar.archivedManyToast", { count: archivable.length });
    showToast(message, [
      {
        id: "undo",
        label: t("sidebar.undo"),
        onClick: () => {
          for (const entries of chunkForSessionUiRequests(snapshot)) {
            void applyUiState({ action: "restore", entries });
          }
          restoreUnread(unreadBefore);
          // The toast held focus; the first family back in the tree takes it.
          focusAfterCommit(() => familyRowButton(archivable[0].root.id));
        },
      },
      { id: "view", label: t("sidebar.viewArchive"), onClick: openArchiveView },
    ]);
  }, [applyUiState, focusAfterCommit, familyRowButton, openArchiveView, restoreUnread, showToast, snapshotUiState, t, unreadSessionIds]);

  // The row's archive button. A running family would come straight back, so
  // it is not archived (the row offers no button for it either).
  const archiveFamily = useCallback((family: SessionFamily) => {
    if (familyIds(family).some((id) => runningSessionIds.has(id))) return;
    archiveFamilies([family]);
  }, [archiveFamilies, runningSessionIds]);

  const restoreFamily = useCallback((family: SessionFamily) => {
    const ids = [family.root.id];
    const snapshot = snapshotUiState(ids);
    void applyUiState({ action: "set", ids, archived: false });
    showToast(t("sidebar.restoredToast", { title: shortTitle(sessionRowTitle(family.root), TOAST_TITLE_MAX) }), [
      {
        id: "undo",
        label: t("sidebar.undo"),
        onClick: () => {
          void applyUiState({ action: "restore", entries: snapshot });
          // Back in the archive view if it is open; else the tab takes focus.
          focusAfterCommit(() => familyRowButton(family.root.id));
        },
      },
    ]);
  }, [applyUiState, familyRowButton, focusAfterCommit, showToast, snapshotUiState, t]);

  const startRename = useCallback((family: SessionFamily) => {
    if (family.root.transient) return;
    setConfirmDeleteRootId(null);
    setRenamingRootId(family.root.id);
  }, []);

  const commitRename = useCallback(async (family: SessionFamily, renameValue: string) => {
    const session = family.root;
    const title = sessionRowTitle(session);
    const name = renameValue.trim();
    setRenamingRootId((current) => (current === session.id ? null : current));
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed first message, so an untouched rename of a
    // skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      void loadSessions();
    } catch {
      // ignore
    }
  }, [loadSessions]);

  const performDelete = useCallback(async (family: SessionFamily) => {
    const session = family.root;
    if (session.transient) return;
    setConfirmDeleteRootId((current) => (current === session.id ? null : current));
    try {
      // The server deletes the family's subagent sessions with it.
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onSessionDeleted?.(session.id);
      void loadSessions();
    } catch {
      // The row stays; the next refresh shows what happened.
    }
  }, [loadSessions, onSessionDeleted]);

  // Only Shift skips the confirmation (Shift+click, Shift+Enter or Shift+D in the menu).
  const requestDelete = useCallback((family: SessionFamily, shiftKey: boolean) => {
    if (shiftKey) {
      void performDelete(family);
    } else {
      setRenamingRootId(null);
      setConfirmDeleteRootId(family.root.id);
    }
  }, [performDelete]);

  const runSessionAction = (id: SessionMenuActionId, row: SessionRow, shiftKey: boolean) => {
    const { family } = row;
    switch (id) {
      case "pin": setFamilyPinned(family, true); break;
      case "unpin": setFamilyPinned(family, false); break;
      case "rename": startRename(family); break;
      case "mark-read": markFamilyRead(family, true); break;
      case "mark-unread": markFamilyRead(family, false); break;
      case "archive": archiveFamily(family); break;
      case "unarchive": restoreFamily(family); break;
      case "delete": requestDelete(family, shiftKey); break;
    }
  };

  const openRowMenu = useCallback((row: SessionRow, anchor: SidebarMenuAnchor, opener: HTMLElement | null) => {
    if (row.status.transient) return;
    setMenu({ kind: "row", row, anchor, opener });
  }, []);

  // Right-click: an extension listening for the downstream event (a pi-web
  // integration) claims the row first; only an unclaimed event opens the
  // built-in menu. A transient row has nothing to offer, so the browser's own
  // menu stays.
  const handleContextMenu = useCallback((row: SessionRow, event: ReactMouseEvent) => {
    const session = row.family.root;
    if (session.id === renamingRootId || session.id === confirmDeleteRootId) return;
    if (dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: event.clientX,
      clientY: event.clientY,
      refresh: () => { void loadSessions(); },
    })) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (session.transient) return;
    event.preventDefault();
    const rowElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    // The keyboard's context-menu key reports no pointer position.
    const anchor: SidebarMenuAnchor = event.clientX === 0 && event.clientY === 0 && rowElement
      ? buttonAnchor(rowElement, "start")
      : { kind: "point", x: event.clientX, y: event.clientY };
    // Focus goes back into the row it came from (the keyboard case). An
    // element elsewhere (the composer) is not made the menu's opener, whose
    // next click the menu would take as "close"; it gets focus back after.
    const active = document.activeElement;
    const inRow = active instanceof HTMLElement && rowElement !== null && rowElement.contains(active);
    contextMenuFocusRef.current = !inRow && active instanceof HTMLElement && active !== document.body ? active : null;
    openRowMenu(row, anchor, inRow ? active : null);
  }, [confirmDeleteRootId, loadSessions, openRowMenu, renamingRootId]);

  const treeSelectionInput = useMemo(() => ({
    sessions: allSessions,
    uiState,
    runningIds: runningSessionIds,
    unreadIds: unreadSessionIds,
    selectedSessionId,
  }), [allSessions, uiState, runningSessionIds, unreadSessionIds, selectedSessionId]);

  const handleGroupMenu = useCallback((project: SidebarProject, opener: HTMLElement) => {
    const olderCount = familiesToArchive(treeSelectionInput, project.key, ARCHIVE_OLDER_THAN_MS, Date.now()).length;
    setMenu({ kind: "group", project, olderCount, anchor: buttonAnchor(opener, "end"), opener });
  }, [treeSelectionInput]);

  const archiveOlderSessions = useCallback((project: SidebarProject) => {
    const ids = familiesToArchive(treeSelectionInput, project.key, ARCHIVE_OLDER_THAN_MS, Date.now());
    archiveFamilies(ids.flatMap((id) => {
      const family = familyByRootId.get(id);
      return family ? [family] : [];
    }));
  }, [archiveFamilies, familyByRootId, treeSelectionInput]);

  // A group's "+": the project's worktrees decide between starting at once in
  // its root and asking which worktree (GET /api/worktrees also makes every
  // listed worktree browsable). The group's own key goes to the shell, so a
  // sibling worktree is never mistaken for another project.
  const handleGroupNew = useCallback((project: SidebarProject, opener: HTMLElement) => {
    const requestId = ++groupNewRequestRef.current;
    const clickedAnchor = buttonAnchor(opener, "end");
    setMenu(null);
    setPendingGroupKey(project.key);
    void fetch(`/api/worktrees?cwd=${encodeURIComponent(project.root)}`, { cache: "no-store" })
      .then((res) => res.json() as Promise<unknown>)
      .catch(() => null)
      .then((data) => {
        if (requestId !== groupNewRequestRef.current) return;
        setPendingGroupKey(null);
        const listing = parseWorktreeListing(data);
        if (listing && needsWorktreePicker(listing)) {
          setMenu({
            kind: "worktrees",
            project,
            listing,
            anchor: opener.isConnected ? buttonAnchor(opener, "end") : clickedAnchor,
            opener,
            form: null,
          });
          return;
        }
        // No choice to make (or no answer): start in the project root.
        startNewSessionInRef.current(listing
          ? { cwd: project.root, projectKey: listing.projectKey, projectRoot: listing.projectRoot }
          : { cwd: project.root, projectKey: project.key });
      });
  }, []);

  // The picker's "New worktree…": create it, then start the session in it.
  const createWorktreeForSession = useCallback(async (listing: WorktreeListing, branch: string) => {
    const setForm = (form: { busy: boolean; error: string | null }) => {
      setMenu((current) => (current?.kind === "worktrees" && current.listing === listing && current.form ? { ...current, form } : current));
    };
    setForm({ busy: true, error: null });
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: listing.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setForm({ busy: false, error: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setWtRefreshKey((k) => k + 1);
      // Closed meanwhile: the worktree exists, but nobody asked for a session any more.
      const current = menuRef.current;
      if (current?.kind !== "worktrees" || current.listing !== listing) return;
      setMenu(null);
      startNewSessionIn({ cwd: data.path, projectKey: listing.projectKey, projectRoot: listing.projectRoot });
    } catch (e) {
      setForm({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [startNewSessionIn]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // After a right-click menu, focus returns to where it was unless the chosen
  // action put it somewhere (a rename field, a delete confirmation).
  useEffect(() => {
    if (menu !== null) return;
    const previous = contextMenuFocusRef.current;
    contextMenuFocusRef.current = null;
    if (!previous?.isConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body) previous.focus({ preventScroll: true });
  }, [menu]);

  // A row whose menu is open can leave the tree (archived or deleted in
  // another window): its menu goes with it.
  const visibleRows = archiveView ? archiveRows : model.rows;
  useEffect(() => {
    if (menu?.kind !== "row") return;
    if (!visibleRows.some((row) => row.key === menu.row.key)) setMenu(null);
  }, [menu, visibleRows]);

  // Rows are rebuilt on every refresh; the menu acts on the current one.
  const menuRow = menu?.kind === "row"
    ? (visibleRows.find((row): row is SessionRow => row.kind === "session" && row.key === menu.row.key) ?? menu.row)
    : null;

  const handleSelectFamily = useCallback((family: SessionFamily) => {
    handleSelectSessionFromList(family.root);
  }, [handleSelectSessionFromList]);

  // Expanding or collapsing a group only changes the view: it never moves the
  // cwd (picking a project does that, in the files tab).
  const handleToggleGroup = useCallback((projectKey: string) => {
    const project = projectByKey.get(projectKey);
    if (!project) return;
    const next = { ...groupExpansion };
    // Re-inserted, so the choice counts as the newest one kept.
    delete next[projectKey];
    next[projectKey] = !isGroupExpanded(project, groupExpansion);
    setGroupExpansion(next);
    saveGroupExpansion(next);
  }, [groupExpansion, projectByKey]);

  const setAllGroupsExpanded = (expanded: boolean) => {
    const next = { ...groupExpansion };
    for (const project of model.projects) {
      delete next[project.key];
      next[project.key] = expanded;
    }
    setGroupExpansion(next);
    saveGroupExpansion(next);
  };

  const handleShowMore = useCallback((key: string) => {
    setMoreShown((prev) => showMoreFamilies(prev, key));
  }, []);
  const handleShowLess = useCallback((key: string) => {
    setMoreShown((prev) => showLessFamilies(prev, key));
  }, []);

  const handleTogglePinned = () => {
    const next = !pinnedCollapsed;
    setPinnedCollapsed(next);
    savePinnedCollapsed(next);
  };

  // "Open in Files" of another project is a deliberate project switch, the
  // same as choosing it in the files tab's project list.
  const openProjectInFiles = (project: SidebarProject) => {
    if (!project.current) setSelectedCwd(project.root);
    filesTabFocusRef.current = "project-button";
    switchTab("files");
  };

  const handleOpenOtherProject = () => {
    filesTabFocusRef.current = "project-list";
    switchTab("files");
    setDropdownOpen(true);
  };
  // The project button takes the focus; when the open project list has a
  // filter field, that field takes it instead (autoFocus).
  useEffect(() => {
    const target = filesTabFocusRef.current;
    if (!target || sidebarTab !== "files") return;
    filesTabFocusRef.current = null;
    if (target === "project-button" || !showProjectFilter) projectButtonRef.current?.focus({ preventScroll: true });
  }, [sidebarTab, showProjectFilter]);

  const sessionMenuItems = (row: SessionRow): SidebarMenuItem[] => sessionMenuEntries(row.context, row.status).map((entry, index) => {
    if (entry.kind === "separator") return { type: "separator", id: `separator-${index}` };
    const label = t(SESSION_ACTION_LABEL_KEYS[entry.id]);
    return {
      type: "item",
      id: entry.id,
      label: entry.id === "delete" ? `${label}…` : label,
      icon: sessionActionIcon(entry.id),
      shortcut: entry.shortcut,
      danger: entry.id === "delete",
      disabled: entry.disabledReason !== undefined,
      disabledReason: entry.disabledReason === "running" ? t("sidebar.cannotArchiveRunning") : undefined,
      onSelect: ({ shiftKey }) => runSessionAction(entry.id, row, shiftKey),
    };
  });

  const groupMenuItems = (project: SidebarProject, olderCount: number): SidebarMenuItem[] => {
    const archivedCount = archiveIndex.countByProject.get(project.key) ?? 0;
    return [
      {
        type: "item",
        id: "pin-project",
        label: t(project.pinned ? "sidebar.unpinProject" : "sidebar.pinProject"),
        icon: project.pinned ? <PinOffIcon /> : <PinIcon />,
        onSelect: () => { void applyUiState({ action: "pin-project", projectKey: project.key, root: project.root, pinned: !project.pinned }); },
      },
      {
        type: "item",
        id: "archive-older",
        label: t("sidebar.archiveOlderThanWeek", { count: olderCount }),
        icon: <ArchiveIcon />,
        disabled: olderCount === 0,
        onSelect: () => archiveOlderSessions(project),
      },
      {
        type: "item",
        id: "open-in-files",
        label: t("sidebar.openInFilesTab"),
        icon: <FolderIcon />,
        onSelect: () => openProjectInFiles(project),
      },
      { type: "separator", id: "separator" },
      {
        type: "item",
        id: "view-archived",
        label: t("sidebar.viewArchived", { count: archivedCount }),
        icon: <ArchiveIcon />,
        disabled: archivedCount === 0,
        onSelect: openArchiveView,
      },
    ];
  };

  const worktreeMenuItems = (project: SidebarProject, listing: WorktreeListing): SidebarMenuItem[] => {
    const current = pickerCurrentWorktreePath(listing, project.key === selectedProject?.key ? currentWorktreePath : null);
    const items: SidebarMenuItem[] = [];
    // The sheet's title already asks the question.
    if (!isMobile) items.push({ type: "header", id: "heading", label: t("sidebar.pickWorktree") });
    for (const worktree of listing.worktrees) {
      items.push({
        type: "item",
        id: `worktree:${worktree.path}`,
        label: worktree.branch ?? projectNameOf(worktree.path),
        mono: true,
        note: worktree.isMain ? t("sidebar.main") : undefined,
        checked: worktree.path === current,
        onSelect: () => startNewSessionIn({ cwd: worktree.path, projectKey: listing.projectKey, projectRoot: listing.projectRoot }),
      });
    }
    items.push({ type: "separator", id: "separator" });
    items.push({
      type: "item",
      id: "new-worktree",
      label: t("sidebar.newWorktree"),
      icon: <PlusIcon />,
      onSelect: ({ keepOpen }) => {
        keepOpen();
        setMenu((state) => (state?.kind === "worktrees" ? { ...state, form: { busy: false, error: null } } : state));
      },
    });
    return items;
  };

  const viewMenuItems = (): SidebarMenuItem[] => [
    { type: "item", id: "collapse-all", label: t("sidebar.collapseAllGroups"), icon: <ChevronIcon />, onSelect: () => setAllGroupsExpanded(false) },
    { type: "item", id: "expand-all", label: t("sidebar.expandAllGroups"), icon: <ChevronIcon className="sidebar-icon-down" />, onSelect: () => setAllGroupsExpanded(true) },
    { type: "separator", id: "separator" },
    {
      type: "item",
      id: "view-archived",
      label: t("sidebar.viewArchived", { count: model.archivedCount }),
      icon: <ArchiveIcon />,
      disabled: model.archivedCount === 0,
      onSelect: openArchiveView,
    },
  ];

  let menuTitle: string | undefined;
  let menuLabel = "";
  // Room for "Archive sessions older than 7 days · N" and branch names.
  let menuWidth: number | undefined;
  let menuItems: SidebarMenuItem[] | undefined;
  let menuBody: ReactNode;
  if (menu?.kind === "row" && menuRow) {
    menuTitle = sessionRowTitle(menuRow.family.root);
    menuLabel = t("sidebar.sessionActions");
    menuItems = sessionMenuItems(menuRow);
  } else if (menu?.kind === "group") {
    menuTitle = menu.project.name;
    menuLabel = t("sidebar.projectActions", { name: menu.project.name });
    menuItems = groupMenuItems(menu.project, menu.olderCount);
    menuWidth = 264;
  } else if (menu?.kind === "worktrees") {
    menuWidth = 240;
    if (menu.form) {
      const { listing, form } = menu;
      menuTitle = t("sidebar.newWorktreeForSession");
      menuLabel = menuTitle;
      menuBody = (
        <WorktreeCreateForm
          heading={isMobile ? null : menuTitle}
          busy={form.busy}
          error={form.error}
          showCancel={!isMobile}
          onCreate={(branch) => { void createWorktreeForSession(listing, branch); }}
          onCancel={closeMenu}
        />
      );
    } else {
      menuTitle = t("sidebar.pickWorktree");
      menuLabel = menuTitle;
      menuItems = worktreeMenuItems(menu.project, menu.listing);
    }
  } else if (menu?.kind === "view") {
    menuTitle = t("sidebar.viewOptions");
    menuLabel = menuTitle;
    menuItems = viewMenuItems();
  }

  // The tree row (and the button in it) that the open menu belongs to.
  const activeMenuRowKey = menu?.kind === "row"
    ? menu.row.key
    : menu?.kind === "group" || menu?.kind === "worktrees"
      ? `group:${menu.project.key}`
      : pendingGroupKey !== null ? `group:${pendingGroupKey}` : null;
  const activeGroupMenu = menu?.kind === "group" ? "more" : menu?.kind === "worktrees" || pendingGroupKey !== null ? "new" : null;

  const treeLayout = isMobile ? "mobile" : "desktop";
  // Until pins and archive have loaded, archived rows would flash in.
  const treeLoading = loading || !uiStateLoaded;
  const treeProps = {
    layout: treeLayout,
    loading: treeLoading,
    error,
    renamingRootId,
    confirmDeleteRootId,
    activeMenuRowKey,
    activeGroupMenu,
    pendingGroupKey,
    onSelectFamily: handleSelectFamily,
    onToggleGroup: handleToggleGroup,
    onShowMore: handleShowMore,
    onShowLess: handleShowLess,
    onTogglePinned: handleTogglePinned,
    onArchiveFamily: archiveFamily,
    onRestoreFamily: restoreFamily,
    onOpenRowMenu: openRowMenu,
    onRowContextMenu: handleContextMenu,
    onRenameCommit: (family: SessionFamily, value: string) => { void commitRename(family, value); },
    onRenameCancel: () => setRenamingRootId(null),
    onDeleteConfirm: (family: SessionFamily) => { void performDelete(family); },
    onDeleteCancel: () => {
      const rootId = confirmDeleteRootId;
      setConfirmDeleteRootId(null);
      // Cancel goes with the confirmation: the row's own button takes focus.
      if (rootId) focusAfterCommit(() => familyRowButton(rootId));
    },
    onGroupNew: handleGroupNew,
    onGroupMenu: handleGroupMenu,
    onOpenOtherProject: handleOpenOtherProject,
    onOpenArchive: openArchiveView,
  } as const;

  const explorerCwd = selectedCwd ?? selectedCwdProp ?? null;
  const archivedCount = model.archivedCount;

  return (
    <div className={`session-sidebar${toast ? " has-toast" : ""}`}>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header */}
      <div className="sidebar-header">
        <PiWebTitle />
        <div className="sidebar-header-actions">
          <button
            type="button"
            className="sidebar-new-button"
            onClick={handleNewSession}
            disabled={!selectedCwd}
            title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
          >
            <PlusIcon size={12} />
            {t("sidebar.new")}
          </button>
          <button
            type="button"
            onClick={() => {
              setWtDropdownOpen(false);
              // Search belongs to the sessions tab: from the files tab it opens there.
              if (sidebarTab !== "sessions") {
                switchTab("sessions");
                setSessionSearchOpen(true);
                return;
              }
              setSessionSearchOpen((open) => !open);
            }}
            title={t("sidebar.toggleSessionSearch")}
            aria-label={t("sidebar.toggleSessionSearch")}
            aria-expanded={sessionSearchOpen}
            aria-controls="session-search-input"
            className={`sidebar-search-toggle${sessionSearchOpen ? " is-active" : ""}`}
          >
            <SearchIcon size={16} />
          </button>
        </div>
      </div>

      {/* Sessions | Files. Only the two tabs are the tablist; the view
          options button beside them is not a tab. */}
      <div className="sidebar-tabs">
        <div className="sidebar-tabs-list" role="tablist" aria-label={t("sidebar.tabsLabel")}>
          <button
            ref={sessionsTabRef}
            type="button"
            role="tab"
            id="session-sidebar-tab-sessions"
            aria-selected={sidebarTab === "sessions"}
            aria-controls="session-sidebar-panel-sessions"
            tabIndex={sidebarTab === "sessions" ? 0 : -1}
            className={`sidebar-tab${sidebarTab === "sessions" ? " is-selected" : ""}`}
            onClick={() => switchTab("sessions")}
            onKeyDown={handleTabKeyDown}
          >
            {t("sidebar.tabSessions")}
          </button>
          <button
            ref={filesTabRef}
            type="button"
            role="tab"
            id="session-sidebar-tab-files"
            aria-selected={sidebarTab === "files"}
            aria-controls="session-sidebar-panel-files"
            tabIndex={sidebarTab === "files" ? 0 : -1}
            title={explorerCwd && changesCount > 0 ? t("sidebar.changedFiles", { count: changesCount }) : undefined}
            className={`sidebar-tab${sidebarTab === "files" ? " is-selected" : ""}`}
            onClick={() => switchTab("files")}
            onKeyDown={handleTabKeyDown}
          >
            {t("sidebar.tabFiles")}
            {explorerCwd && changesCount > 0 && <span className="sidebar-tab-count" aria-hidden="true">{changesCount}</span>}
          </button>
        </div>
        <span className="sidebar-tabs-spacer" />
        {sidebarTab === "sessions" && (
          <button
            type="button"
            className={`sidebar-icon-button${menu?.kind === "view" ? " is-active" : ""}`}
            title={t("sidebar.viewOptions")}
            aria-label={t("sidebar.viewOptions")}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "view"}
            onClick={(event) => setMenu({ kind: "view", anchor: buttonAnchor(event.currentTarget, "end"), opener: event.currentTarget })}
          >
            <MoreIcon size={14} />
          </button>
        )}
      </div>

      {/* Sessions tab: every project's sessions, or the archive */}
      <div
        ref={sessionsPanelRef}
        id="session-sidebar-panel-sessions"
        role="tabpanel"
        aria-labelledby="session-sidebar-tab-sessions"
        hidden={sidebarTab !== "sessions"}
        className="sidebar-panel"
        onScrollCapture={rememberScroll}
      >
        {sessionSearchOpen && (
          <div className="sidebar-search">
            <input
              id="session-search-input"
              type="search"
              autoFocus
              value={sessionSearchQuery}
              maxLength={200}
              aria-label={t("sidebar.searchSessions")}
              placeholder={t("sidebar.searchSessions")}
              onChange={(event) => setSessionSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.stopPropagation();
                  setSessionSearchQuery("");
                }
              }}
              className="sidebar-search-input"
            />
          </div>
        )}
        <SessionSearch
          open={sessionSearchOpen}
          query={sessionSearchQuery}
          selectedSessionId={selectedSessionId}
          onSelectSession={handleSelectSessionFromList}
          archivedSessionIds={archiveIndex.ids}
        >
          {/* Kept mounted under the archive view, so going back finds it as it was. */}
          <div className="sidebar-sessions-view" hidden={archiveView}>
            <SessionTree {...treeProps} rows={model.rows} emptyLabel={t("sidebar.noSessions")} />
          </div>
          {archiveView && (
            <div className="sidebar-sessions-view">
              <div className="sidebar-archive-bar">
                <button
                  ref={archiveBackRef}
                  type="button"
                  className="sidebar-archive-back"
                  title={t("sidebar.backToSessions")}
                  aria-label={`${t("sidebar.backToSessions")}: ${t("sidebar.archivedCount", { count: archivedCount })}`}
                  onClick={() => setArchiveView(false)}
                >
                  <ChevronIcon size={13} className="sidebar-icon-back" />
                  <span>{t("sidebar.archived")}</span>
                  <span className="sidebar-archive-count">· {archivedCount}</span>
                </button>
              </div>
              <SessionTree {...treeProps} rows={archiveRows} emptyLabel={t("sidebar.noArchived")} />
            </div>
          )}
        </SessionSearch>
      </div>

      {/* Files tab: the project and worktree in use, and its files */}
      <div
        ref={filesPanelRef}
        id="session-sidebar-panel-files"
        role="tabpanel"
        aria-labelledby="session-sidebar-tab-files"
        hidden={sidebarTab !== "files"}
        className="sidebar-panel"
        onScrollCapture={rememberScroll}
      >
        {/* CWD picker */}
        <div ref={dropdownRef} className="sidebar-project">
          <button
            ref={projectButtonRef}
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            aria-expanded={dropdownOpen}
            className={`sidebar-project-button${selectedCwd ? "" : " is-empty"}`}
          >
            <FolderIcon size={13} className="sidebar-project-icon" />
            {selectedCwd ? (
              <>
                <span className="sidebar-project-name">{projectNameOf(selectedProject?.root ?? selectedCwd)}</span>
                <PathLabel text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)} className="sidebar-project-path" />
              </>
            ) : (
              <span className="sidebar-project-placeholder">
                {initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject")}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                className="sidebar-project-activity"
                role="img"
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
              />
            )}
            <ChevronIcon size={10} className="sidebar-project-chevron" />
          </button>

          <AnimatedDropdown open={dropdownOpen} style={DROPDOWN_STYLE}>
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
                    autoFocus
                    style={{
                      width: "100%",
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
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => (
                  <button
                    key={project.key}
                    onClick={() => {
                      setSelectedCwd(project.root);
                      setProjectFilter("");
                      setCustomPathOpen(false);
                      setCustomPathError(null);
                      setDropdownOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: project.key === selectedProject?.key ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={project.root}
                  >
                    {project.key === selectedProject?.key && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {project.key !== selectedProject?.key && <span style={{ width: 10, flexShrink: 0 }} />}
                    <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                    {showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                ))}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} className="sidebar-worktree">
              <button
                type="button"
                onClick={() => setWtDropdownOpen((v) => !v)}
                title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                aria-expanded={wtDropdownOpen}
                className="sidebar-worktree-button"
              >
                <BranchIcon size={11} className={`sidebar-worktree-icon${currentWorktree && !currentWorktree.isMain ? " is-linked" : ""}`} />
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  className="sidebar-worktree-label"
                />
                {currentWorktree?.isMain && (
                   <span className="sidebar-worktree-note">{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span className="sidebar-worktree-note">
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <ChevronIcon size={10} className="sidebar-worktree-chevron" />
              </button>

              <AnimatedDropdown open={wtDropdownOpen} style={DROPDOWN_STYLE}>
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
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
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <TrashIcon size={12} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "var(--accent-contrast)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            className="sidebar-worktree-button is-inactive"
          >
            <BranchIcon size={11} className="sidebar-worktree-icon" />
            <span className="sidebar-worktree-label">{inactiveWorktreeSelector.label}</span>
          </button>
        )}

        {explorerCwd && (
          <div className="sidebar-files-toolbar">
            <span className="sidebar-files-title">{t("files.explorer")}</span>
            <ToolbarIconButton
              onClick={() => { void openInFileManager(); }}
              disabled={fileManagerUnavailable}
              title={fileManagerUnavailable
                ? t(fileManager?.reason === "remote" ? "sidebar.openInExplorerRemoteOnly" : "sidebar.openInExplorerUnsupported")
                : fileManagerLabel}
            >
              <FolderIcon size={13} />
            </ToolbarIconButton>
            {onOpenTerminal && (
              <ToolbarIconButton
                onClick={() => onOpenTerminal(explorerCwd)}
                title={t("terminal.open")}
              >
                <TerminalIcon size={13} />
              </ToolbarIconButton>
            )}
            {changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                pressed={!changesCollapsed}
              >
                <ChangesIcon size={13} />
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                setFileSearchOpen((open) => !open);
              }}
              title={t("sidebar.searchFiles")}
              pressed={fileSearchOpen}
            >
              <SearchIcon size={13} />
            </ToolbarIconButton>
            <ToolbarIconButton
              onClick={() => fileExplorerRef.current?.openUploadPicker()}
              disabled={explorerUploadBusy}
              title={t("sidebar.uploadFilesTitle")}
            >
              <UploadIcon size={13} />
            </ToolbarIconButton>
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              done={explorerRefreshDone}
            >
              {explorerRefreshDone ? <CheckIcon size={13} /> : <RefreshIcon size={13} />}
            </ToolbarIconButton>
          </div>
        )}
        {explorerCwd && fileManagerErrorMessage && (
          <div role="alert" className="sidebar-files-error">
            <span className="sidebar-files-error-text">{fileManagerErrorMessage}</span>
            <DismissButton onClick={() => setFileManagerError(null)} title={t("files.dismissError")} />
          </div>
        )}
        {/* Mounted whenever there is a cwd, also while the tab is hidden, so the
            expanded tree, a search and an upload in progress survive a switch. */}
        <div ref={explorerScrollRef} className="sidebar-files-scroll scrollbar-subtle">
          {explorerCwd && (
            <FileExplorer
              ref={fileExplorerRef}
              cwd={explorerCwd}
              onOpenFile={onOpenFile ?? (() => {})}
              refreshKey={explorerKey}
              onAtMention={onAtMention}
              onAtMentions={onAtMentions}
              onUploadBusyChange={setExplorerUploadBusy}
              changesCollapsed={changesCollapsed}
              onChangesCountChange={setChangesCount}
              fileSearchOpen={fileSearchOpen}
              onFileSearchOpenChange={setFileSearchOpen}
            />
          )}
        </div>
      </div>

      <SidebarMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        sheet={isMobile}
        ariaLabel={menuLabel}
        title={menuTitle}
        items={menuItems}
        cancelLabel={t("sidebar.cancel")}
        onClose={closeMenu}
        returnFocusTo={menu?.opener ?? null}
        width={menuWidth}
      >
        {menuBody}
      </SidebarMenu>
      <SidebarToast toast={toast} onDismiss={() => setToast(null)} dismissLabel={t("sidebar.dismiss")} />
    </div>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="animate-spin"
            style={{ display: "block" }}
          >
            <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

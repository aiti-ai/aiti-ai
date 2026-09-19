"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiUrl, inAppPathname, withBasePath } from "@/lib/base-path";
import { openViewerWindowHost } from "@/lib/open-viewer-window-host";
import { fmtMoney, fmtMoneySmall, fxNote, useMoneySynced } from "@/lib/money";
import { homeDirService } from "@/lib/home-dir";

import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { PiWebTitle } from "./PiWebTitle";
import { ChatWindow, type CompactControls } from "./ChatWindow";
import { contextUrgency, CTX_BREATHE_CSS } from "@/lib/context-urgency";
import type { ChatScrollPosition } from "@/lib/chat-scroll-position";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { TabBody, type TabBodyCtx } from "./TabBody";
import { DetachedTabWindow } from "./DetachedTabWindow";
import { openFileTab, openFolderTab, saveFileViewerState, findDormantFileFacePath } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import dynamic from "next/dynamic";
import { ExtSlotsProvider, ExtSlot, TakeoverSlot, useExtSlotItems, useExtMetas, dispatchChatSend, ExtItemBoundary, registerExtClientService, ensureExtMaterialized } from "./ExtSlots";
import { ProviderUsagePanel } from "./ProviderUsagePanel";
/** Lazy-loaded SessionSidebar (unified dock plan §7-2): in takeover mode (sidebarContent
 *  has a taker) this component is not rendered at all and the chunk never loads, keeping
 *  the main bundle slim; in fallback mode it is fetched on first render (local chunk,
 *  millisecond-scale load window). ssr:false: the component depends on localStorage
 *  two-phase restore, so server rendering adds nothing. */
const SessionSidebarLazy = dynamic(
  () => import("./SessionSidebar").then((m) => ({ default: m.SessionSidebar })),
  { ssr: false, loading: () => null },
);
import { hasExtRender } from "@/lib/ext-ui-store";
import type { ExtRenderProps, ExtUiItemRegistered } from "@/lib/ext-ui-store";
import { getExtUiItems, subscribeExtUi } from "@/lib/ext-ui-store";

/** SSR-stable empty snapshot for the pathPicker slot (getServerSnapshot must return a
 *  cached reference, otherwise it loops forever). */
const NO_PATH_PICKER_ITEMS: ExtUiItemRegistered[] = [];

/**
 * A router.replace to the same URL triggers an App Router RSC refetch (observed in
 * practice: opening a page adds 3 extra requests: /?_rsc=… + manifest.webmanifest +
 * icons/icon-192.png — a soft-navigation metadata re-render). Skip entirely when the
 * target location matches the current address (the URL is already in the target state,
 * replace gains nothing). Query-string comparison is kept: real changes such as
 * "clear ?session= and go home" still replace as usual.
 */
function replaceLocationIfChanged(
  router: ReturnType<typeof useRouter>,
  href: string,
  options?: { scroll?: boolean },
): void {
  if (typeof window !== "undefined") {
    const queryOnly = href.startsWith("?");
    const [rawPath, targetQuery = ""] = href.split("?");
    const normalize = (p: string) => p.replace(/\/+$/, "") || "/";
    // router.replace's href is app-relative (Next adds basePath itself) — restore it
    // to the actual browser address before comparing ("/" vs current "/dev/" under a
    // /dev deployment should compare equal).
    const targetPath = queryOnly ? window.location.pathname : withBasePath(rawPath);
    const samePath = normalize(window.location.pathname) === normalize(targetPath);
    // Target href without a query string = intentionally clearing params (e.g. "clear
    // ?session= and go home"): skip only if the current address truly has no query
    // string. This used to read `!targetQuery ||` (always true) — every param-clearing
    // replace was silently swallowed, the address bar kept the stale ?session=, and a
    // refresh always restored that old session.
    const sameQuery = targetQuery
      ? `?${targetQuery}` === window.location.search
      : !window.location.search;
    if (samePath && sameQuery) return;
  }
  router.replace(href, options);
}
import { registerHostApi } from "@/lib/ext/host-api";
import { HOST_UI_SERVICE } from "@/lib/ext/host-ui-contract";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { RestartRecoveryWizard } from "./RestartRecoveryWizard";
import { BackendConnBanner } from "./BackendConnBanner";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { TerminalPanelBridge } from "./TerminalPanelBridge";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { useTheme } from "@/hooks/useTheme";
import { THEME_OPTIONS } from "@/lib/theme";
import { ThemeIcon } from "./ThemeIcon";
import { useI18n } from "@/hooks/useI18n";
import { useIsCompact, useIsMobile, useIsNarrowMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useOverlayBack } from "@/hooks/useOverlayBack";
import { acquireOverlayBack } from "@/lib/overlay-back";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { getDraftApi } from "@/lib/composer/draft-api";
import { sendAgentCommand } from "@/lib/agent-client";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";
import { runOutcomeNotifies, truncateRunError } from "@/lib/run-outcome";
import { getInitialNavigation, type InitialNavigation } from "@/lib/initial-navigation";
import {
  SEPARATOR,
  TOPBAR_HIDDEN_KEY,
  TOPBAR_ORDER_KEY,
  normalizeTopbarOrder,
  readTopbarHidden,
  readTopbarOrder,
  resolveTopbarLayout,
  writeTopbarHidden,
  writeTopbarOrder,
  type TopbarItemId,
  type TopbarOrderItem,
} from "@/lib/topbar-order";
import {
  clearLastOpen,
  clearLastOpenSessionById,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import { clearCachedModels, readMostRecentCachedCwd } from "@/lib/models-client-cache";
import { prefetchModels } from "@/hooks/useAgentSession";
import {
  piWebSessionService,
  publishSessionState,
  setSessionOpener,
  type PiWebSessionSource,
} from "@/lib/pi-web-session-store";
import { piWebToastService } from "@/lib/pi-web-toast-store";
import { HostToastHost } from "./HostToastHost";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { QueueEntry } from "@/lib/queue-store";
import { ExportDialog } from "./ExportDialog";
import { SessionNameDialog } from "./SessionNameDialog";
import type { FileExplorerHandle } from "./FileExplorer";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { ToolEntry } from "@/lib/tool-presets";
import { getSessionFamily } from "@/lib/session-family";
import { getRecentProjects } from "@/lib/project-groups";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

declare global {
  interface Window {
    /**
     * Close/switch confirmation interface injected by the file-editor extension
     * (fileViewer takeover). Optional — absent when the extension has not taken over
     * or is not loaded; the core always allows the action then. The core only
     * consumes confirmClose; _restoreSession is a private extension method (restores
     * the editing session when the panel reopens) — a fragile coupling the extension
     * should turn into a public API soon.
     */
    __aitiEditor?: {
      confirmClose?: (p: string, opts?: { isSwitch?: boolean }) => boolean | Promise<boolean>;
      _restoreSession?: () => void;
      /** File dock face (file-editor extension file-dock, 2026-09-16): optional —
       *  absent when the extension is not deployed, and host guards/menu items
       *  degrade gracefully. See the file-dock-face plan doc for semantics. */
      hasFileFace?: (p: string) => boolean;
      openFileFace?: (p: string, opts?: { auto?: boolean }) => void;
      dockFile?: (p: string, zone: "sidebar" | "right-panel") => void;
    };
  }
}

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const AGENT_PANEL_WIDTH = 420;
const SELECTION_MENU_WIDTH = 176;
/** Right-panel tab keep-alive pool cap (see the right-dock keep-alive plan doc);
 *  a localStorage override of 0 = evict everything (back to pure tombstone semantics). */
const RIGHT_PANEL_ALIVE_MAX = 5;
const RIGHT_PANEL_ALIVE_KEY = "pi-web:right-panel:alive-max";

/** Notification text: truncate overlong summaries. */
function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Session title for task-completion notifications: prefer the session name, fall back
 *  to a summary of the first message when unnamed (avoids a generic "task finished"). */
function notificationSessionTitle(session: SessionInfo | null, fallback: string): string {
  const name = session?.name?.trim();
  if (name) return name;
  const first = session?.firstMessage?.trim();
  if (first) return truncateText(first, 42);
  return fallback;
}

/** Project context label in notifications: <project root name>(<branch>), omitted when unknown. */
function notificationProjectLabel(session: SessionInfo | null): string {
  const root = session?.projectRoot || session?.cwd;
  const base = root ? root.split(/[\\/]/).filter(Boolean).pop() : null;
  const parts: string[] = [];
  if (base) parts.push(base);
  if (session?.branch) parts.push(`(${session.branch})`);
  return parts.join(" ");
}

/** Declarative extension item icon (meta.icon, ExtUiItemIcon) → standard grayscale line
 *  rendering (16px, color follows currentColor). Three forms: { svg } inline markup
 *  (24×24 viewBox, lucide line style) / emoji / an in-extension .svg file (CSS-mask).
 *  Shared by the "⋯" menu icon slot and declarative toolbar buttons (ExtToolbarIconButton). */
function renderExtItemIcon(icon: NonNullable<ExtUiItemRegistered["meta"]>["icon"], extId?: string): React.ReactNode {
  if (icon == null) return null;
  if (typeof icon === "object" && "svg" in icon) {
    return (
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: icon.svg }}
      />
    );
  }
  if (typeof icon === "string" && icon.endsWith(".svg")) {
    const url = apiUrl(`/api/extensions/${extId ?? ""}/assets/${icon}`);
    return (
      <span
        aria-hidden
        style={{
          display: "inline-block", width: 16, height: 16, flexShrink: 0, verticalAlign: "middle",
          background: "currentColor",
          WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")`,
          WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
          WebkitMaskPosition: "center", maskPosition: "center",
          WebkitMaskSize: "contain", maskSize: "contain",
        }}
      />
    );
  }
  return <span style={{ fontSize: 15, lineHeight: 1 }}>{String(icon)}</span>;
}

/** Declarative toolbar button (extension registerItems supplies meta.icon +
 *  meta.onClick with no render): the host renders a standard 36×36 grayscale icon
 *  button (right divider + hover tint), identical to each extension's own buttons —
 *  the look belongs to the host, preventing per-extension style-constant drift
 *  (2026-08 contract; see the docs extension-points reference). */
function ExtToolbarIconButton({ item }: { item: ExtUiItemRegistered }) {
  const icon = item.meta?.icon;
  const title = item.meta?.title ?? item.meta?.label ?? item.id;
  // [lazy-load v2] While a static item's click-triggered materialization is in
  // flight: semi-transparent + click-guarded; static declarations without an icon
  // render the label's first character as a placeholder (icons are required by the
  // SOP; the placeholder is a fallback only).
  const pending = item.pending === true;
  return (
    <button
      type="button"
      title={pending ? `${title} …` : title}
      disabled={pending}
      onClick={(e) => { if (!pending) { const cb = item.meta?.onClick; if (typeof cb === "function") cb(e); } }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
        background: "none", borderTop: "none", borderBottom: "none", borderLeft: "none",
        borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
        opacity: pending ? 0.45 : 1,
      }}
    >
      {icon != null
        ? renderExtItemIcon(icon, item.extId)
        : <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1 }}>{(item.meta?.label ?? item.id).slice(0, 1)}</span>}
    </button>
  );
}

// Unified session-state service (P3 plan §4.3): registered at module top level —
// module evaluation happens before the effect phase, so the service is already
// available whenever any extension client materializes (consumers should still
// null-check and degrade for older hosts).
// Snapshot publication is driven by the session-state effect inside AppShell.
registerExtClientService("pi-web", "pi-web.session", piWebSessionService);
// Shared home-directory singleton (dedupes the /api/home call on page open):
// extensions consume ensure() via ctx.getExtService("pi-web.home") instead of
// each fetching on their own.
registerExtClientService("pi-web", "pi-web.home", homeDirService);
// Unified toast service (2026-09-13): the host owns the top-right queue; extensions
// consume it via ctx.getExtService("pi-web.toast").show — replacing per-extension
// toasts (component state + setTimeout); rendering belongs to HostToastHost (mounted by AppShell).
registerExtClientService("pi-web", "pi-web.toast", piWebToastService);
// Small-screen "system back" overlay-close service (2026-09-14): the history back
// stack has a single in-process writer; extensions must not listen to popstate on
// their own. Floating dialogs from the floating-dialog extension join via
// ctx.getExtService("pi-web.overlayBack").acquire(close); whether to enable on
// small screens only is decided by the consumer (host built-in overlays use
// useOverlayBack(isMobile && open, close)).
registerExtClientService("pi-web", "pi-web.overlayBack", {
  /** Register a layer that closes on system back; returns { release }. The caller
   *  is responsible for small-screen gating. */
  acquire: (close: () => void) => acquireOverlayBack(close),
});

export function AppShell({ extSlotDeclarations }: { extSlotDeclarations?: Record<string, string[]> | null } = {}) {
  // Hydration-complete signal: extensions (e.g. the draft-keeper extension) must
  // apply their startup restore only after hydration, otherwise a dev-mode
  // hydration-mismatch re-render would wipe the restored text using the server
  // HTML (an empty box).
  useEffect(() => {
    (window as unknown as { __piWebHydrated?: boolean }).__piWebHydrated = true;
    window.dispatchEvent(new Event("pi-web:hydrated"));
  }, []);
  const router = useRouter();
  const searchParams = useSearchParams();
  // useSearchParams returns an empty instance on the server render, and in
  // dev without a Suspense boundary it stays empty after hydration — so the
  // ?session=/?cwd= restore would never fire. Read the query string straight
  // from the location on mount; a re-render after that is harmless.
  const [initialNavigation, setInitialNavigation] = useState<InitialNavigation>(() => getInitialNavigation(searchParams));
  useEffect(() => {
    if (typeof window !== "undefined") {
      setInitialNavigation(getInitialNavigation(new URLSearchParams(window.location.search)));
    }
  }, []);
  const { preference, setThemePreference } = useTheme();
  const themeLabelKey = `theme.${preference}`;
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();
  // Icon buttons are uniformly 36px wide (matching extension buttons); icon size is
  // also fixed at 16px (iconDim inside renderTopbarItem)
  const isNarrowMobile = useIsNarrowMobile();
  useViewportHeight();

  // Once the user has granted notification permission, register a Web Push
  // subscription so the server can notify backgrounded PWAs (notably iOS,
  // which suspends page JS and never receives the SSE completion event).
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    void setupPushSubscription(locale);
  }, [locale]);
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true");
    } catch {
      // Browser storage is best-effort.
    }
  }, []);
  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelectionEnabled(enabled);
    try {
      localStorage.setItem("pi-quote-selection-enabled", String(enabled));
    } catch {
      // Keep the current page usable when storage is unavailable.
    }
  }, []);
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
  }, []);
  const sessionsWithSelection = useMemo(() => {
    if (!selectedSession) return sessionCatalog;
    return [
      ...sessionCatalog.filter((session) => session.id !== selectedSession.id),
      selectedSession,
    ];
  }, [selectedSession, sessionCatalog]);
  const activeSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, selectedSession?.id),
    [selectedSession?.id, sessionsWithSelection],
  );
  const hasSubagentSessions = Boolean(activeSessionFamily?.subagents.length);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  // Target cwd chosen on the new-session page's "workspace" selector (null = current
  // workspace): the switch does not happen immediately on selection — only when the
  // session is actually created (handleSessionCreated).
  const [newSessionWorkspace, setNewSessionWorkspace] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatScrollPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current === target ? null : current);
  }, []);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const exportQueueDataRef = useRef<(() => Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>) | null>(null);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  // "Directory does not exist" notice bar (made visible on trust-check 400
  // "Directory does not exist", replacing a silent console error)
  const [cwdMissingNotice, setCwdMissingNotice] = useState<string | null>(null);
  // Upstream #712: collapse the sidebar initially when embedding with ?sidebar=collapsed
  const [sidebarOpen, setSidebarOpen] = useState(() => !initialNavigation.sidebarCollapsed);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelExpanded, setRightPanelExpanded] = useState(false);
  const rightPanelFullWidth = rightPanelOpen && rightPanelExpanded && !isMobile;
  useEffect(() => {
    if (!rightPanelOpen || isMobile) setRightPanelExpanded(false);
  }, [rightPanelOpen, isMobile]);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  // Panel expansion immediately restores the files/folders the last session had open (aiti-editor session
  // tombstone restore; the extension-side _sessionRestored one-shot guard prevents repeats and
  // openFileTab/openFolderTab are idempotent). This logic was once inlined in the file-panel toggle button's
  // onClick and got dropped by the upstream handleRightPanelToggle refactor → expanding the panel no longer
  // loaded history. Converged into an effect: every expansion path (toggle/open file/open folder/extension
  // openFile) triggers it. See AppShell.file-history-restore.test.mjs.
  useEffect(() => {
    if (!rightPanelOpen) return;
    const restore = window.__aitiEditor?._restoreSession;
    if (typeof restore === "function") {
      setTimeout(() => restore(), 0);
    }
  }, [rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const themeBtnRef = useRef<HTMLButtonElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoadIdRef.current += 1;
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  // Top-bar money display: subscribe to FX rates only when there is a real cost
  // (otherwise the page open does not fetch /api/fx; once cost arrives the flag
  // flips true and the ¥ part is filled in on the next render after rates load).
  useMoneySynced((sessionStats?.cost ?? 0) > 0);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Manual naming dialog for bridge-occupied sessions (fallback path when auto-name
   *  cannot start a local runtime) */
  const [bridgedNameDialog, setBridgedNameDialog] = useState<{ sessionId: string; defaultName: string } | null>(null);
  /** "Fetch latest session stats" callback registered by ChatWindow (includes
   *  contextUsage for idle sessions) */
  const [sessionStatsRefresh, setSessionStatsRefresh] = useState<(() => void) | null>(null);
  /** Compact-control tri-state registered by ChatWindow (compact/abort/cancelQueue +
   *  isCompacting/compactQueued) — data source for the session-info panel's compact button */
  const [compactControls, setCompactControls] = useState<CompactControls | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Model list warm-up: before the real cwd (session restore / default project pick)
  // is ready, fire one /api/models request with the most recently used cwd (hits an
  // in-flight/shared request; on success writes the client cache) — this moves the
  // network round-trip ahead of mount so model names are already there when
  // ChatWindow replays the cache. Runs once on mount only; loading and refreshing
  // for the real cwd remain the responsibility of useAgentSession.
  useEffect(() => {
    const recentCwd = readMostRecentCachedCwd();
    if (recentCwd) prefetchModels(recentCwd);
  }, []);

  // Model-config change broadcast: the model-wizard extension (aggregation/multi-key
  // save) dispatches `pi-web:models-changed` → refresh the model list (useAgentSession
  // re-fetches /api/models) without waiting for the 60s server cache or a manual refresh.
  // Also clear the client cache: the next loadModels replay must reflect the new config.
  useEffect(() => {
    const onModelsChanged = () => {
      clearCachedModels();
      setModelsRefreshKey((key) => key + 1);
    };
    window.addEventListener("pi-web:models-changed", onModelsChanged);
    return () => window.removeEventListener("pi-web:models-changed", onModelsChanged);
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Current display model — fed by ChatWindow, consumed by the session-info
  // "remaining quota" block to pin the current provider on top.
  const [currentModelInfo, setCurrentModelInfo] = useState<{ provider: string; modelId: string } | null>(null);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "system" | "tools" | "session" | "language" | "theme" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!sessionHasBranches) {
      setActiveTopPanel((panel) => panel === "branches" ? null : panel);
    }
  }, [sessionHasBranches]);

  useEffect(() => {
    if (!hasSubagentSessions) {
      setActiveTopPanel((panel) => panel === "agents" ? null : panel);
    }
  }, [hasSubagentSessions]);

  useEffect(() => {
    if (rightPanelFullWidth) setActiveTopPanel(null);
  }, [rightPanelFullWidth]);

  const toggleTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session" | "language" | "theme",
    keepMobileToolbarOpen = false,
  ) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile]);

  const handleSystemInfoToggle = useCallback((
    panel: "system" | "tools",
    keepMobileToolbarOpen = false,
  ) => {
    const opening = activeTopPanel !== panel;
    toggleTopPanel(panel, keepMobileToolbarOpen);
    if (!opening || systemInfoLoading) return;

    const load = systemInfoLoaderRef.current;
    if (!load) return;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoadIdRef.current === loadId) {
        setSystemInfoLoading(false);
      }
    });
  }, [activeTopPanel, systemInfoLoading, toggleTopPanel]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    // Idle sessions have no live state to read (the wrapper was idle-GC'd), so fetch
    // get_session_stats once when the panel opens to make sure the context % row has
    // a value (on mobile this is the only place to see it).
    sessionStatsRefresh?.();
    setActiveTopPanel("session");
  }, [isMobile, sessionStatsRefresh]);

  /** Collapse all top-bar dropdown panels (pi-web.ui service member closeTopPanels) —
   *  extension items inside a top-bar panel call this before opening another
   *  full-screen surface (e.g. the AI-usage report dock): a panel left open would
   *  cover the new surface on small screens (observed: only the tab header remained
   *  visible). Same semantics as the panel ✕ button (setActiveTopPanel(null)). */
  const closeTopPanels = useCallback(() => setActiveTopPanel(null), []);

  /** Registration channel for ChatWindow's "fetch latest session stats" callback
   *  (onSessionStatsRefresherRegister).
   *  ⚠️ Do NOT pass setSessionStatsRefresh directly as the registration function:
   *  ChatWindow registers a function, and React treats a function argument as a
   *  functional update handed straight to basicStateReducer and executes it
   *  immediately — opening a session would unexpectedly issue get_session_stats
   *  (and without a wrapper even cold-start the whole runtime; observed in prod:
   *  that is exactly how an idle wrapper was born), and the callback itself would
   *  never be stored in state (its return value undefined is what gets stored).
   *  Here an updater returns the callback itself, storing the "function" as a value. */
  const handleSessionStatsRefresherRegister = useCallback((refresher: (() => void) | null) => {
    if (!refresher) {
      setSessionStatsRefresh(null);
      return;
    }
    setSessionStatsRefresh(() => refresher);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, []);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile]);

  const handleRightPanelExpandToggle = useCallback(() => {
    setActiveTopPanel(null);
    setRightPanelExpanded((expanded) => !expanded);
  }, []);


  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [isMobile, isNarrowMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const el = topBarRef.current;
    const update = () => {
      const topBarRect = el.getBoundingClientRect();
      if ((activeTopPanel === "language" || activeTopPanel === "theme") && !isMobile) {
        // The language/theme button may have been folded into the "⋯" overflow
        // (no inline copy, ref is null) → anchor to the "⋯" button instead
        const anchor = activeTopPanel === "theme"
          ? (themeBtnRef.current ?? moreBtnRef.current)
          : (languageBtnRef.current ?? moreBtnRef.current);
        if (anchor) {
          const buttonRect = anchor.getBoundingClientRect();
          const width = Math.min(
            SELECTION_MENU_WIDTH,
            topBarRect.width,
          );
          const left = Math.min(
            buttonRect.left - 1,
            Math.max(topBarRect.left, topBarRect.right - width),
          );
          setTopPanelPos({ top: topBarRect.bottom, left, width });
          return;
        }
      }
      if (activeTopPanel === "agents") {
        setTopPanelPos({
          top: topBarRect.bottom,
          left: topBarRect.left,
          width: Math.min(AGENT_PANEL_WIDTH, topBarRect.width),
        });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (languageBtnRef.current) ro.observe(languageBtnRef.current);
    if (moreBtnRef.current) ro.observe(moreBtnRef.current);
    if (themeBtnRef.current) ro.observe(themeBtnRef.current);
    return () => {
      ro.disconnect();
    };
  }, [activeTopPanel, isMobile]);

  // Files unmount when inactive; workspace terminals stay mounted until closed.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  // Tab-bar auto-reveal token (TabBar revealToken): incremented only on
  // "user-initiated open/activate" paths — opening a file/folder (select:true),
  // clicking a tab, opening a terminal, foregrounding a dock panel, re-docking a
  // detached tab. History restore (session tombstones opened silently in bulk with
  // select:false), its fallback activation, and close/detach fallback never increment —
  // background-opened tabs must not steal focus or move the tab-bar scroll position.
  const [fileTabRevealToken, setFileTabRevealToken] = useState(0);
  const revealFileTabOnOpen = useCallback(() => setFileTabRevealToken((n) => n + 1), []);

  // ═══ [floating-dialog extension tab-detach v0.6.0] tabHost two-state machine (plan §3/§5.1) ═══
  // detachedTabIds only records the "window" state (default is panel); not persisted —
  // after a refresh everything returns to panel (tabs are transient work objects, and
  // returning to the regular layout on refresh is a clean default; float-window
  // position memory is keyed by tabId and naturally expires when keys mismatch after
  // refresh). Single-instance invariant: a detached tab stays out of panelTabs, out of
  // the right panel's always-mounted list, and out of the content area — the window
  // list = existing tabs ∩ detached, structurally preventing double rendering.
  const [detachedTabIds, setDetachedTabIds] = useState<Set<string>>(new Set());
  // Right-panel content-area size at the instant of detach (initial geometry the
  // window grows out of in place; falls back to 720×480 if measurement fails).
  const rightPanelContentRef = useRef<HTMLDivElement | null>(null);
  const [detachInitGeom, setDetachInitGeom] = useState({ w: 720, h: 480 });
  // ═══ [tab-detach state end] ═══
  // Restore companion: the extension's _restoreSession opens historical files in the
  // background (select:false, leaving focus to the file the user just explicitly
  // opened — see the extension's registry.ts comment). When only panel expansion
  // triggered the restore there is no "just-opened file", which would leave the
  // "tabs exist but none active" empty state. This state-driven fallback: panel open,
  // tabs exist, none active → activate the last current tab (in the restore flow that
  // is the first restored historical file; when later files open, activeId is already
  // non-null and the guard guarantees no re-swap, so there is no timing race). The
  // single-remaining-tab activation is already handled by performCloseFileTab; this
  // state is unreachable outside the restore scenario and cannot steal user focus.
  // E2E-verified: expand → content renders, no empty-state hint.
  // This activation is a background fallback (not user-initiated) → fileTabRevealToken
  // is not incremented: the tab bar does not scroll, and a position the user manually
  // scrolled away from is not yanked back by history restore.
  useEffect(() => {
    // tab-detach: auto-activation only picks from tabs visible inside the panel (detached tabs take no right-panel activation slot)
    const visibleTabs = fileTabs.filter((t) => !detachedTabIds.has(t.id));
    if (!rightPanelOpen || visibleTabs.length === 0 || activeFileTabId !== null) return;
    setActiveFileTabId(visibleTabs[visibleTabs.length - 1].id);
  }, [activeFileTabId, fileTabs, detachedTabIds, rightPanelOpen]);
  // pathPicker capability (FolderSwitcher from the folder extension): consumed by the
  // top-bar "open folder". SSR-stable empty snapshot.
  const pathPickerItems = useSyncExternalStore(
    subscribeExtUi,
    () => getExtUiItems("pathPicker"),
    () => NO_PATH_PICKER_ITEMS,
  );

  // [extension] T2 takeover: workspace terminal tabs are kept (sessionStorage session-memory
  // semantics unchanged); tab content is decided by a three-layer TerminalPanelBridge
  // arbitration: the command-terminal extension's terminalDock takes priority; if the
  // manifest is ready and nobody claims takeover → fall back to the native PTY panel
  // (lib/terminal-manager + /api/terminal, see docs/terminal.md).
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsRestored, setTerminalsRestored] = useState(false);

  // ═══ [floating-dialog extension dock v0.5.0 batch A, 2026-09-08 re-added] right-panel dock tabs ═══
  // ⚠ This block (dockPanelStates mirror / panelTabs dock derivation / present-change
  // open coupling / activation fallback) was once lost entirely in a historical
  // upstream merge (the handleCloseFileTab consumer and content dispatch survived but
  // were unreachable). When re-adding, keep the whole block together; do not split it
  // when editing AppShell — see the float-dock plan doc §4.3/§11.
  // Data flow: the floating-dialog extension's dock.ts (or the _shared/ext-float-dock.ts
  // fallback store when float is not installed) emits `piwe-float-present-change` →
  // the host mirrors the shape → the derived surface renders only items in state
  // docked:right-panel as tabs (id "dock:<extId>:<itemId>"); the host imports zero
  // extension code (the decoupling channel = the same-named event + the
  // `piwe-float-present-command` command event; see the dock branch of handleCloseFileTab).
  const rightDockItems = useExtSlotItems("rightFileDock").filter(hasExtRender);
  const [dockPanelStates, setDockPanelStates] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const onPresent = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; state: string; auto?: boolean }>).detail;
      if (!detail?.key) return;
      setDockPanelStates((prev) => {
        const next = new Map(prev);
        if (detail.state === "closed") {
          // ✕ (after TabBar ✕ converts to a command event the state machine echoes
          // closed): activation rests on the closed dock tab → fall back to other
          // dock:right-panel tabs / the most recent file/terminal tab (same fallback
          // semantics as performCloseFileTab). No visible tab left in the right panel
          // → collapse the panel (closing the last tab auto-collapses, no "no open
          // files" empty state is left behind).
          const wasRightPanelTab = prev.get(detail.key) === "docked:right-panel";
          next.delete(detail.key);
          const remainingDockIds = [...next.entries()]
            .filter(([, state]) => state === "docked:right-panel")
            .map(([key]) => `dock:${key}`);
          setActiveFileTabId((cur) => {
            if (cur !== `dock:${detail.key}`) return cur;
            return remainingDockIds.at(-1) ?? fileTabs.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? null;
          });
          if (wasRightPanelTab && remainingDockIds.length === 0 && fileTabs.length === 0 && terminalTabs.length === 0) {
            setRightPanelOpen(false);
          }
        } else {
          next.set(detail.key, detail.state);
        }
        return next;
      });
      // Open coupling (triggered only by explicit dock commands; same-state idempotent
      // dispatches emit no event → repeated open/floating after manually collapsing the
      // right panel will not wrongly re-expand it): auto-expand the right panel and
      // activate the corresponding dock tab.
      if (detail.state === "docked:right-panel") {
        setRightPanelOpen(true);
        revealFileTabOnOpen(); // dock panel opened from the toolbar/extension → bring the target tab into view
        setActiveFileTabId(`dock:${detail.key}`);
      }
      // Left-panel dock coupling (right-panel semantics mirrored for the left): when a
      // panel docks into a left-panel block (docked:sidebar:*), expand the sidebar
      // proactively — on small screens the sidebar is hidden as an overlay drawer by
      // default (collapsed on mobile load), and without expanding it the user cannot
      // see a panel docked there via plan/task buttons at all; on desktop the sidebar
      // is always open and setSidebarOpen(true) is idempotent with no side effects.
      // The legacy sidebar-explorer value is handled as well.
      // auto flag = non-user-initiated restorative stacking (autoDock persistent
      // blocks restored after refresh) → do not expand (otherwise the drawer would be
      // wrongly pulled up by restorative stacking after load, breaking the "collapsed
      // on mobile load" design).
      if (!detail.auto && (detail.state === "docked:sidebar-explorer" || detail.state.startsWith("docked:sidebar:"))) {
        setSidebarOpen(true);
      }
    };
    window.addEventListener("piwe-float-present-change", onPresent);
    // v3.1 activation coupling: re-open/dock of an already-docked panel into the same
    // zone (no state transition, no change event) → the state machine emits activate —
    // expand the right panel and bring the corresponding tab to front (fixes "toolbar
    // re-open of a background dock does not bring it forward").
    // Only fires in docked state; floating is idempotent and emits no event, so
    // "re-opening a float after manually collapsing the right panel does not wrongly
    // expand it" is preserved.
    const onActivate = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; state: string; auto?: boolean }>).detail;
      if (!detail?.key || !detail.state?.startsWith("docked:")) return;
      // Restorative activation (auto: autoDock/project coupling replay after refresh)
      // expands no panel: small-screen right-panel/sidebar overlays are not pulled up
      // by the load process (same semantics as the auto gating in onPresent above).
      if (detail.auto) return;
      // Left-panel dock same-state re-activation (panel already docked in the sidebar,
      // repeated open/switch back): expand the sidebar to pull up the small-screen
      // overlay drawer — same semantics as the right-panel activation coupling below
      // (the sidebar has no tab slot; expanding is all that is needed).
      if (detail.state === "docked:sidebar-explorer" || detail.state.startsWith("docked:sidebar:")) {
        setSidebarOpen(true);
        return;
      }
      if (!detail.state.startsWith("docked:right-panel")) return;
      setRightPanelOpen(true);
      revealFileTabOnOpen(); // re-opening an already-docked panel brings it to front (user action) → bring the target tab into view
      setActiveFileTabId(`dock:${detail.key}`);
    };
    window.addEventListener("piwe-float-present-activate", onActivate);
    return () => {
      window.removeEventListener("piwe-float-present-change", onPresent);
      window.removeEventListener("piwe-float-present-activate", onActivate);
    };
  }, [fileTabs, terminalTabs, revealFileTabOnOpen]);
  // ═══ [floating-dialog extension dock batch A re-add end] ═══

  const panelTabs: Tab[] = [
    // detached tabs stay out of the right-panel render surface (rendered only once in
    // the detached window — single-instance invariant §3)
    ...fileTabs.filter((t) => !detachedTabIds.has(t.id)),
    ...terminalTabs.filter((t) => !detachedTabIds.has(t.id)).map((tab) => ({
      id: tab.id,
      label: getFileName(tab.cwd) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    // dock tabs (batch A): only items in docked:right-panel state render as tabs —
    // ✕ close → the state machine echoes closed → mirror delete → the tab disappears;
    // floating/closed/sidebar-docked occupy no tab slot. Activation reuses
    // activeFileTabId (terminal tab precedent) and stays out of fileTabs/terminalTabs
    // state (zero dedicated state).
    })),
    ...rightDockItems
      .filter((it) => dockPanelStates.get(it.id) === "docked:right-panel")
      .map((it) => ({ id: `dock:${it.id}`, label: it.meta?.title || it.meta?.label || it.extId || it.id, filePath: "", kind: "dock" as const })),
  ];

  // Detached-window list = existing tabs ∩ detached (file/folder/terminal; dock tab
  // detaching goes through the state machine's present float, not this list). Removing
  // a tab removes its window (performCloseFileTab need not know about detached).
  const detachedWindows: Tab[] = [
    ...fileTabs,
    ...terminalTabs.map((tab) => ({
      id: tab.id,
      label: getFileName(tab.cwd) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: tab.closing,
      restored: tab.restored,
    })),
  ].filter((t) => detachedTabIds.has(t.id));

  // ── [right-panel tab keep-alive pool] FIFO keep-alive for file/folder/dock tabs
  //   (see the right-dock keep-alive plan doc). The tombstone approach exists because
  //   the right-panel content area mounts only the active tab's TabBody (switching
  //   fully unloads/remounts Monaco). Pool semantics: the most recently activated
  //   non-terminal tabs stay mounted (hidden for inactive ones), oldest evicted FIFO
  //   past the cap; an evicted tab falls back to reload semantics the next time it is
  //   switched to (EditorApp unmount cleanup still writes cache + dispose). Default
  //   cap 5, overridable via localStorage.
  const [panelKeepAlive, setPanelKeepAlive] = useState<string[]>([]);
  // Freshest panelTabs snapshot (synced each render; the keep-alive effect reads the
  // latest id set through it instead of listing panelTabs — a new reference every
  // frame — in deps; reading a ref does not trip exhaustive-deps, standard React pattern)
  const panelTabsRef = useRef(panelTabs);
  panelTabsRef.current = panelTabs;
  useEffect(() => {
    if (!activeFileTabId) return;
    if (terminalTabs.some((t) => t.id === activeFileTabId)) return; // terminal has its own always-mounted container; not pooled
    setPanelKeepAlive((prev) => {
      // Drop the current active first (it is re-appended below) + drop stale ids of
      // closed/detached tabs (not in panelTabs; the render layer already filters them,
      // this keeps dead ids from occupying the pool. When a non-active tab closes the
      // active id is unchanged and this effect does not re-run, so a dead id lingers
      // until the next activation switch cleans it up — no visible impact).
      const ids = new Set(panelTabsRef.current.map((t) => t.id));
      const next = prev.filter((id) => id !== activeFileTabId && ids.has(id));
      next.push(activeFileTabId); // append = most recently used
      let max = RIGHT_PANEL_ALIVE_MAX;
      try {
        const n = parseInt(localStorage.getItem(RIGHT_PANEL_ALIVE_KEY) ?? "", 10);
        if (Number.isFinite(n) && n >= 0) max = n;
      } catch { /* ignore */ }
      while (next.length > max) {
        const oldest = next.shift();
        if (oldest === activeFileTabId) break; // never evict the current active tab
      }
      return next;
    });
  }, [activeFileTabId, terminalTabs]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.activeId) {
        setActiveFileTabId(saved.activeId);
        setRightPanelOpen(saved.open);
      }
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeFileTabId,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeFileTabId, rightPanelOpen, terminalsRestored]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  // Reveal a directory in the sidebar file tree (from an @ mention popover).
  const handleRevealDir = useCallback((absPath: string) => {
    fileExplorerRef.current?.revealPath(absPath);
    setSidebarOpen(true);
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // Unified session-state service (P3): source marker of the most recent session-state
  // change (for diagnostics/extension decisions, e.g. url-failed = the URL ?session=
  // was invalid).
  const sessionSourceRef = useRef<PiWebSessionSource>(initialNavigation.sessionId ? "url" : "initial");
  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // The session restored from ?session= is the authoritative pick for this page
  // load: the last-open memory (shared localStorage, possibly rewritten by
  // another window) must not yank it afterwards. The fallback sidebar → dock
  // takeover handoff re-notifies the same cwd, and an identity mismatch in
  // handleCwdChange misreads that as a project switch, firing
  // restoreWorkspaceContext — on refresh this surfaced as "every session URL
  // lands on the same fixed session". Cleared by a real user session pick or a
  // genuine cross-project switch (different cwd).
  const urlRestoredSessionRef = useRef<{ id: string; cwd: string | null } | null>(
    initialSessionId ? { id: initialSessionId, cwd: null } : null,
  );
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);
  // Latest pending ?session= id for the 404 cleanup inside handleOpenSession:
  // some restore callers race past the initialRestore flag, so the failed id
  // matching the URL param is the reliable signal.
  const initialSessionIdRef = useRef<string | null>(initialSessionId);
  initialSessionIdRef.current = initialSessionId;

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Unified session-state service (P3): derive a snapshot and publish it on real
  // changes (publish internally dedupes on the phase/requestedId/sessionId/session
  // summary, so repeated renders have no side effects).
  useEffect(() => {
    const phase = selectedSession
      ? "active"
      : (initialSessionId && !initialSessionRestored)
        ? "resolving"
        : "none";
    publishSessionState({
      phase,
      requestedId: initialSessionId ?? null,
      sessionId: selectedSession?.id ?? null,
      session: selectedSession
        ? {
            id: selectedSession.id,
            cwd: selectedSession.cwd,
            name: selectedSession.name,
            firstMessage: selectedSession.firstMessage,
          }
        : null,
      // source normalization: while a URL ?session= exists but has not yet been
      // attributed by any handler, the resolving phase records "url" (initial only
      // applies to the first frame without a URL session).
      source: sessionSourceRef.current === "initial" && initialSessionId
        ? "url"
        : sessionSourceRef.current,
    });
  }, [selectedSession, initialSessionId, initialSessionRestored]);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectKey
      ?? activeProjectKeyRef.current
      ?? workspaceKeyOf(selectedSession);
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  // Expose the current session cwd for the global emergency indicator
  // (ExtErrorIndicator 🚑 → /api/emergency); null when there is no session
  // (emergency entries are user-filled or go through global-error)
  useEffect(() => {
    (window as unknown as { __piWebCwd?: string | null }).__piWebCwd = selectedSession?.cwd ?? null;
  }, [selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch(apiUrl("/api/cwd/validate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        // If a live fresh composer already exists for the same cwd (handleCwdChange
        // already generated the uuid), do not overwrite it: avoids draftId jitter
        // scattering one input across multiple new: slots (draft scatter).
        const draftId = activeNewSessionDraftKeyRef.current
          && activeNewSessionDraftKeyRef.current.startsWith(`new:`)
          && activeNewSessionDraftKeyRef.current.endsWith(`:${data.cwd}`)
          ? activeNewSessionDraftKeyRef.current.slice(4, activeNewSessionDraftKeyRef.current.length - data.cwd.length - 1)
          : `initial-${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string, cwd: string) => {
    // While a ?session= restore is authoritative for this page load, the
    // last-open memory must not override it: that memory is shared across
    // windows and usually points at whichever session another window has
    // open — overriding it is exactly the "refresh ignores my session URL"
    // bug. A genuine user switch clears the guard first (see handleCwdChange).
    if (urlRestoredSessionRef.current) return;
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch(apiUrl("/api/sessions"))
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if (workspaceKeyOf(s) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        activeNewSessionDraftKeyRef.current = null;
        sessionSourceRef.current = "restore";
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          replaceLocationIfChanged(router, `?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    invalidateWorkspaceRestore();
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Cross-project switch. Cold start (currentProject === null) is the
    // sidebar's first identity sync, not a user switch: restoring the
    // remembered session here would yank a fresh composer (and its just
    // recovered draft) away to a historical session on every reload, so the
    // restore only fires when the user actually moves between projects.
    setNewSessionWorkspace(null); // real workspace switch (not a same-cwd identity hydration) → drop the staged target
    const isUserProjectSwitch = currentProject !== null && currentProject !== newProject;
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const draftKey = `new:${draftId}:${cwd}`;
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = draftKey;
    // source attribution only on a genuine user project switch (the cold-start
    // first sync must not overwrite — otherwise it would overwrite the url-failed
    // marker left by a failed URL restore with cwd-switch, and extensions could
    // no longer tell the two apart).
    if (isUserProjectSwitch) sessionSourceRef.current = "cwd-switch";
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isUserProjectSwitch) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);
      if (!activeFileTabId || activeFileTabId.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
      // A genuinely different cwd is a real user project move: from here on
      // the last-open restore of the new workspace applies again.
      if (urlRestoredSessionRef.current?.cwd && cwd !== urlRestoredSessionRef.current.cwd) {
        urlRestoredSessionRef.current = null;
      }
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      restoreWorkspaceContext(newProject, cwd);
    }
    // Do not erase a pending ?session= param here: the takeover/fallback
    // sidebar handoff can route a cold-start cwd notification through this
    // handler before the URL restore consumed the id (store channels arrive
    // in batches). Rewriting to "/" at that point destroys the restore input
    // and refresh silently ignores the session URL. Once restore is resolved,
    // clear only a param that no longer matches the selected session — the
    // param of the session the user is actually viewing must survive so a
    // later refresh restores the same conversation.
    if (initialSessionRestored || !initialSessionId) {
      const urlSession = new URLSearchParams(window.location.search).get("session");
      if (!urlSession || urlSession !== selectedSession?.id) {
        replaceLocationIfChanged(router, inAppPathname("/"), { scroll: false });
      }
    }
  }, [activeCwd, activeFileTabId, initialSessionId, initialSessionRestored, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false, entryId?: string, blockIndex?: number) => {
    sessionSourceRef.current = isRestore ? "url" : "select";
    // URL restore wins for this page load; a user pick hands authority back
    // to explicit selections (last-open restores apply again afterwards).
    urlRestoredSessionRef.current = isRestore ? { id: session.id, cwd: session.cwd } : null;
    setNewSessionWorkspace(null); // picking an existing session → drop the new-session page's staged target
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    // Advance the project identity to the selected session's project BEFORE the
    // sidebar cwd-sync effect fires. Otherwise handleCwdChange sees a project
    // change (e.g. picking a session from another project in the all-sessions
    // panel / kanban) and tears the just-selected session down — the first click
    // would always fail and only a second click (same project) would stick.
    activeProjectKeyRef.current = workspaceKeyOf(session);
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    // Adopt an explicitly selected session before the sidebar reports its cwd.
    const projectKey = workspaceKeyOf(session);
    if (activeProjectKeyRef.current !== projectKey) {
      setFileTabs([]);
      if (!activeFileTabId || activeFileTabId.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
      setActiveTopPanel(null);
    }
    activeProjectKeyRef.current = projectKey;
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      replaceLocationIfChanged(router, `?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [activeCwd, activeFileTabId, invalidateWorkspaceRestore, router, isMobile, newSessionCwd, selectedSession]);

  // [extension] Extension-client open-session channel: pi-web:open-session { id } → resolve
  // by id and reuse handleSelectSession (in-SPA switch, no full page navigation).
  // Lets extension panels (e.g. the subagent fleet) open parent/child session message
  // windows while keeping their own dialogs up.
  const handleSelectSessionRef = useRef(handleSelectSession);
  handleSelectSessionRef.current = handleSelectSession;
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (typeof id !== "string" || !id) return;
      // P0-A: a single request uses the lightweight meta endpoint (~1KB); on 404 fall
      // back to the single /api/sessions/<id> (info shape, no full list pull and no
      // forced rescan) — no longer falling back to a full refresh=1.
      const selectById = (s: SessionInfo) => handleSelectSessionRef.current(s);
      void fetch(apiUrl(`/api/sessions/${encodeURIComponent(id)}/meta`))
        .then((r) => (r.status === 404 ? fetch(apiUrl(`/api/sessions/${encodeURIComponent(id)}`)) : r))
        .then((r) => (r.ok ? (r.json() as Promise<{ session?: SessionInfo; info?: SessionInfo; sessions?: SessionInfo[] }>) : null))
        .then((d) => {
          const s = d?.session ?? d?.info ?? d?.sessions?.find((x) => x.id === id);
          if (s) selectById(s);
        })
        .catch(() => { /* ignore */ });
    };
    window.addEventListener("pi-web:open-session", handler);
    return () => window.removeEventListener("pi-web:open-session", handler);
  }, []);

  // [extension] Service-worker notification click → open the session inside the SPA: sw.js
  // no longer client.navigate's an already-open window (that equals a full reload via
  // the address bar); it postMessages the page instead, and this forwards to the
  // pi-web:open-session channel above (fetch meta → selectById, zero reload).
  // Only service-worker sources are handled (event.source is a ServiceWorker object);
  // regular window postMessage (e.g. the viewer-extension composer protocol) goes
  // through a separate listener, so the two never interfere.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const onSwMessage = (event: MessageEvent) => {
      if (!(event.source instanceof ServiceWorker)) return;
      const d = event.data as { type?: string; url?: string; sessionId?: string } | null;
      if (!d || d.type !== "pi-web:open-session") return;
      const id = d.sessionId
        ?? (d.url ? new URL(d.url, window.location.origin).searchParams.get("session") : null);
      if (id) {
        window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id } }));
      } else {
        window.focus();
      }
    };
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onSwMessage);
  }, []);

  const handleNewSession = useCallback((sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
    sessionSourceRef.current = "cwd-switch";
    setNewSessionWorkspace(null); // explicit new session → return to the current workspace, do not inherit a stale staged target
    const draftKey = `new:${sessionId}:${cwd}`;
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    replaceLocationIfChanged(router, inAppPathname("/"), { scroll: false });
  }, [invalidateWorkspaceRestore, router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // [extension] Extension-client new-session channel: pi-web:new-session { cwd } → switch
  // to the new-session page (no server session is created; the first message is sent
  // by the user on the welcome page). Serves "@ to a new session"-style features:
  // the extension first writes window.__piWebPendingComposer with the prefill text
  // (consumed once ChatInput mounts), then dispatches this event.
  useEffect(() => {
    const handler = (e: Event) => {
      const cwd = (e as CustomEvent).detail?.cwd;
      if (typeof cwd !== "string" || !cwd) return;
      // On mobile collapse the sidebar/right panel (file tabs live in the right
      // panel; leaving it open would cover the target composer — same as @ insertion)
      setRightPanelOpen(false);
      handleNewSession(`ext-${Date.now()}`, cwd);
    };
    window.addEventListener("pi-web:new-session", handler);
    return () => window.removeEventListener("pi-web:new-session", handler);
  }, [handleNewSession]);

  // [extension] Standalone viewer child-window composer request (viewer-extension protocol
  // reuse): the child window has no chat surface, so the extension's @ mentions /
  // @ to a new session / selection AI postMessage back to the opener to execute.
  // Message shape: see forwardComposerToOpener in app/viewer/page.tsx; origin check
  // plus source/type gating.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const d = ev.data as { source?: string; type?: string; action?: string; text?: unknown; cwd?: unknown } | null;
      if (!d || d.source !== "aiti-viewer" || d.type !== "composer") return;
      const text = typeof d.text === "string" ? d.text : "";
      if (!text) return;
      if (d.action === "append") {
        chatInputRef.current?.appendText(text);
      } else if (d.action === "newSession") {
        (window as unknown as { __piWebPendingComposer?: { text: string; at: number } }).__piWebPendingComposer = { text, at: Date.now() };
        const cwd = typeof d.cwd === "string" && d.cwd ? d.cwd : activeCwd;
        if (!cwd) return;
        setRightPanelOpen(false);
        handleNewSession(`ext-${Date.now()}`, cwd);
      } else if (d.action === "steer") {
        dispatchChatSend(text, "steer");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleNewSession, activeCwd]);

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    // Use ?refresh=1 to bypass the 5s TTL cache: a new session's .jsonl may
    // have just been persisted, and a stale cache hit would leave
    // selectedSession as a transient draft (no name, transient=true).
    // P0-A: a single hydrate uses the lightweight meta endpoint; on 404 fall back to
    // the single /api/sessions/<id> (info shape, direct id lookup unaffected by list
    // scan caching) — no longer falling back to a full refresh=1.
    void fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/meta`), { cache: "no-store" })
      .then((r) => (r.status === 404 ? fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), { cache: "no-store" }) : r))
      .then((r) => (r.ok ? (r.json() as Promise<{ session?: SessionInfo; info?: SessionInfo; sessions?: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.session ?? d?.info ?? d?.sessions?.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  const handleOpenSession = useCallback(async (sessionId: string, options?: { initialRestore?: boolean }) => {
    try {
      const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), { cache: "no-store" });
      const data = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !data.info) {
        // The initial ?session= restore pointed at a deleted session (404): clear the
        // stale last-open record + clear the URL immediately. On the normal path the
        // URL is cleaned by the "default project pick → handleCwdChange → replace"
        // chain; this is the failure-path fallback (does not wait for the next list
        // refresh). The check is "requested id === URL id being restored" rather than
        // just the initialRestore flag — some restore callers drop the flag, and the
        // cost of clearing the wrong thing (wiping someone else's URL session param)
        // far outweighs missing a clear.
        if (response.status === 404 && (options?.initialRestore || sessionId === initialSessionIdRef.current)) {
          clearLastOpenSessionById(sessionId);
          // Restore failed: release the authority guard so the normal
          // last-open behavior applies for the rest of this page load.
          urlRestoredSessionRef.current = null;
          replaceLocationIfChanged(router, inAppPathname("/"), { scroll: false });
        }
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      handleSelectSession(data.info);
      // The by-id fallback of the initial ?session= restore (id not in the
      // sidebar list) is part of the URL restore: anchor the guard AFTER
      // handleSelectSession — it selects with isRestore=false and would
      // otherwise clear the anchor set here.
      if (options?.initialRestore) {
        urlRestoredSessionRef.current = { id: data.info.id, cwd: data.info.cwd };
      }
      return true;
    } catch (error) {
      console.error("[pi-web] failed to open session:", error instanceof Error ? error.message : error);
      return false;
    }
  }, [handleSelectSession, router]);

  // pi-web.session.open(id) delegation backfill (same pattern as hostUiRef: refresh
  // each render to avoid a stale closure). Extensions (e.g. welcome-page widgets)
  // consume it via the ctx service; host built-ins call openSessionById directly.
  setSessionOpener(handleOpenSession);
  useEffect(() => () => setSessionOpener(null), []);

  // Canonicalization of external-session placeholder/alias ids (the server resolves
  // zcode:new-* / aliases into real composite ids): migrate the selected id and URL
  // in place without bumping sessionKey — the mounted chat/SSE keeps using the old
  // registration (server-side double registration guarantees hits), and the next
  // entry fully uses the canonical id. Sidebar row identities unify accordingly, so
  // the same backend session no longer shows two rows (transient row + list row).
  const handleSessionIdCanonicalized = useCallback((previousId: string, canonicalId: string) => {
    sessionSourceRef.current = "canonicalized";
    setSelectedSession((s) => (s && s.id === previousId ? { ...s, id: canonicalId } : s));
    if (new URLSearchParams(window.location.search).get("session") === previousId) {
      replaceLocationIfChanged(router, `?session=${encodeURIComponent(canonicalId)}`, { scroll: false });
    }
    // Notify the session-manager dock: the old id's unflushed draft row has been
    // superseded by the canonical row (same session) and can be removed
    try {
      window.dispatchEvent(new CustomEvent("pi-web:session-id-canonicalized", { detail: { previousId, canonicalId } }));
    } catch { /* ignore outside browser environments */ }
  }, [router]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    sessionSourceRef.current = "created";
    setRefreshKey((k) => k + 1);
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setNewSessionWorkspace(null);
    // "Workspace" selection on the new-session page: only after the session is
    // successfully created in the chosen workspace does the app context (sidebar /
    // file area / URL) formally switch to it. This must rewrite the project identity
    // BEFORE the sidebar's selectedCwd (=session.cwd) sync fires, otherwise
    // handleCwdChange would read it as a cross-project switch and tear down the
    // session just created.
    if (session.cwd && session.cwd !== activeCwd) {
      setActiveCwd(session.cwd);
      activeProjectKeyRef.current = workspaceKeyOf(session);
      setFileTabs([]);
      if (!activeFileTabId || activeFileTabId.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
    }
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    replaceLocationIfChanged(router, `?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [activeCwd, activeFileTabId, invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? withBasePath(`/?session=${encodeURIComponent(targetSession.id)}`) : withBasePath("/");
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
      void setupPushSubscription(locale);
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") {
          fire();
          void setupPushSubscription(locale);
        }
      });
    }
  }, [handleSelectSession, locale]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);

    if (selectedSession?.relation?.kind === "subagent") return;
    const targetSession = selectedSession;
    // Include session context: title = task name (name/first-message summary), body =
    // project(+branch) + status text, so the notification shows at a glance "which task
    // in which project" and its result.
    const projectLabel = notificationProjectLabel(targetSession);
    const deliverCompleted = () => deliverSessionNotification({
      targetSession,
      title: notificationSessionTitle(targetSession, translate("i18n.sessionComplete")),
      body: projectLabel
        ? translate("i18n.taskFinishedWithContext", { project: projectLabel })
        : translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });

    // Outcome triage (2026-09-15): the run's final status is derived from the session
    // file (lightweight single /meta fetch) — failed → "task failed: <error summary>";
    // user-stopped (aborted) / interrupted → no notification; success/unknown → keep
    // the original "task finished". When the final status cannot be read (bridge /
    // external session / request failure), conservatively notify as finished so the
    // notification does not disappear entirely.
    if (!targetSession) {
      if (shouldShowBrowserNotification()) deliverCompleted();
      return;
    }
    void fetch(apiUrl(`/api/sessions/${encodeURIComponent(targetSession.id)}/meta`), { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ session?: SessionInfo }>) : null))
      .then((d) => {
        if (!shouldShowBrowserNotification()) return;
        const lastRun = d?.session?.lastRun;
        if (lastRun && !runOutcomeNotifies(lastRun.status)) return;
        if (lastRun?.status === "failed") {
          const error = truncateRunError(lastRun.error, 120);
          deliverSessionNotification({
            targetSession,
            title: notificationSessionTitle(targetSession, translate("i18n.sessionFailed")),
            body: projectLabel
              ? (error
                ? translate("i18n.taskFailedWithContextAndError", { project: projectLabel, error })
                : translate("i18n.taskFailedWithContext", { project: projectLabel }))
              : (error
                ? translate("i18n.taskFailedWithError", { error })
                : translate("i18n.taskFailed")),
            tag: `pi-session-complete:${targetSession.id}`,
          });
          return;
        }
        deliverCompleted();
      })
      .catch(() => {
        // Failed to read the final status: keep the old behavior (completion notification)
        if (shouldShowBrowserNotification()) deliverCompleted();
      });
  }, [deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (selectedSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;

    // Probe for bridge occupancy up front: a session claimed by the TUI bridge cannot
    // start a local runtime for the naming turn (it would double-write the jsonl, and
    // the master gate raises BridgeOccupiedError → 409). Degrade directly to the manual
    // naming dialog — PATCH /api/sessions/[id] supports the bridged scenario
    // (set_session_name is forwarded to the bridge side).
    try {
      const probeRes = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/state`));
      const probeBody = (await probeRes.json().catch(() => ({}))) as { bridged?: boolean; code?: string };
      const bridged = (probeRes.ok && probeBody.bridged === true)
        || (!probeRes.ok && probeBody.code === "session_bridged_unreachable");
      if (bridged) {
        const displayFirst = skillExpansionToCommand(selectedSession?.firstMessage ?? "")
          ?? selectedSession?.firstMessage ?? "";
        setBridgedNameDialog({
          sessionId,
          defaultName: selectedSession?.name || displayFirst.trim().slice(0, 50) || sessionId.slice(0, 12),
        });
        // Toast explaining the degrade reason (the dialog itself also explains — double
        // hint so users mid-switch don't miss it); routed through the host pi-web.toast
        // service (rendered by HostToastHost)
        piWebToastService.show(translate("title.bridgedToast"));
        setActiveTopPanel(null);
        return;
      }
    } catch {
      // Probe failure does not block: continue the normal flow (the server still
      // returns the 409 fallback on bridge occupancy)
    }

    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`), {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession]);

  /** After a bridge-occupied session is named manually: refresh the list + sync the
   *  top-bar title/stats (same as the auto-name success path). */
  const handleBridgedNameSaved = useCallback((sessionId: string, title: string) => {
    setRefreshKey((key) => key + 1);
    if (activeSessionIdRef.current !== sessionId) return;
    setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
    setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
    setAutoNameStatus({ kind: "success" });
    autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
  }, []);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    sessionSourceRef.current = "fork";
    activeNewSessionDraftKeyRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setNewSessionWorkspace(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    }));
    hydrateSelectedSession(newSessionId);
    replaceLocationIfChanged(router, `?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleAskInNewChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    sourceEntryId: string,
  ) => {
    const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
      type: "fork_branch",
      entryId: sourceEntryId,
    });
    if (!result?.newSessionId) throw new Error(translate("chat.quoteForkFailed"));
    setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
    handleSessionForked(result.newSessionId);
  }, [handleSessionForked, translate]);

  const handleInitialRestoreDone = useCallback(() => {
    // Called only on the failed ?session= URL-restore path (success goes through
    // handleSelectSession("url")).
    if (initialNavigation.sessionId) sessionSourceRef.current = "url-failed";
    setInitialSessionRestored(true);
  }, [initialNavigation.sessionId]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    // Wipe any persisted drafts (all tabs' slots) for the deleted session.
    getDraftApi()?.clearAllDrafts(sessionId);
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      sessionSourceRef.current = "deleted";
      const cwd = selectedSession.cwd;
      const draftId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setNewSessionWorkspace(null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
      replaceLocationIfChanged(router, inAppPathname("/"), { scroll: false });
    }
  }, [invalidateWorkspaceRestore, selectedSession, router]);

  const openHostFileTab = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; select?: boolean },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const select = options?.select !== false; // default true
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint,
      sourceSessionId,
      tabId,
    }));
    if (select) {
      setActiveFileTabId(tabId);
      revealFileTabOnOpen(); // user opened a new tab → the tab bar follows it into view
      setRightPanelOpen(true);
      // On mobile the file panel is full-screen; close the drawer so it shows.
      if (isMobile) setSidebarOpen(false);
    }
  }, [isMobile, revealFileTabOnOpen]);


  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; select?: boolean },
  ) => {
    // File dock face guard (file-editor extension file-dock, 2026-09-16): the path is
    // alive as a dock face (float window / left-panel block / right-panel dock tab) →
    // bring it to the front (present open uses dockpref placement / same-state
    // activation) instead of creating a host tab. auto = restorative open
    // (select:false) must not pull up the small-screen drawer. When the extension is
    // absent, hasFileFace is absent → a normal host tab is created.
    const ed = window.__aitiEditor;
    if (typeof ed?.hasFileFace === "function" && typeof ed.openFileFace === "function" && ed.hasFileFace(filePath)) {
      ed.openFileFace(filePath, { auto: options?.select === false });
      return;
    }
    // [lazy-materialization window guard, 2026-09-19] lazy loading of the file-editor
    // extension (clientImmediately:false): after a refresh the face API is not yet
    // mounted while the instance list (persistent localStorage) still exists. Falling
    // straight through to a host tab here means the editor later materializes and
    // auto-presents a float in front → the same file opens twice (host tab + float
    // stacked over the message area; on mobile it looks like "opened but didn't
    // switch / mixed content"). Dormant face hit → materialize the extension first,
    // then openFileFace; on materialization failure (extension deleted/disabled) fall
    // back to a host tab.
    if (typeof ed?.hasFileFace !== "function" || typeof ed?.openFileFace !== "function") {
      const facePath = findDormantFileFacePath(filePath);
      if (facePath) {
        void ensureExtMaterialized("aiti-editor").then((ok) => {
          const api = window.__aitiEditor;
          if (ok && typeof api?.hasFileFace === "function" && typeof api?.openFileFace === "function" && api.hasFileFace(facePath)) {
            api.openFileFace(facePath, { auto: options?.select === false });
          } else {
            openHostFileTab(facePath, fileName, options);
          }
        }).catch(() => { openHostFileTab(filePath, fileName, options); });
        return;
      }
    }
    openHostFileTab(filePath, fileName, options);
  }, [isMobile, revealFileTabOnOpen, openHostFileTab]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  // "Open in file panel" for message images: the image tab mechanism was removed
  // (image previews are now handled by the file-editor extension's unified viewer
  // float; entry point in components/editor-image-preview.ts; falls back to the
  // upstream lightbox when the extension is absent).

  // File-editor extension session-files endpoint (folder tabs reuse the same tombstone
  // record/restore pipeline as files — kind distinguishes them). Centralized
  // here so only a real tab close removes (switch/refresh keep the tombstone).
  const recordFolder = useCallback((
    folderPath: string,
    action: "add" | "remove",
  ) => {
    const sid = (window as unknown as { __aitiEditor?: { _sessionId?: string } }).__aitiEditor?._sessionId;
    if (!sid || !folderPath) return;
    void fetch(apiUrl("/api/extensions/aiti-editor/session-files"), {
      method: "POST", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sid, filePath: folderPath, kind: "folder", action }),
    }).catch(() => {});
  }, []);

  const handleOpenFolder = useCallback((
    folderPath: string,
    folderName: string,
    options?: { select?: boolean },
  ) => {
    // Folder dock face first (folders uniformly go through the dock state machine —
    // the right-panel dock tab carries the full ⇱ position menu / ✕ / double-click
    // detach; the legacy folder tab has none of these controls). Falls back to the
    // legacy tab when the extension is not deployed/mounted. openFolderDocked
    // internally presents dock:right-panel → the host auto-expands the right panel and
    // activates the tab via piwe-float-present-change (including idempotent activate).
    const dockApi = (window as unknown as { __aitiFolder?: { openFolderDocked?: (p: string, z: string) => void } }).__aitiFolder;
    if (dockApi && typeof dockApi.openFolderDocked === "function") {
      dockApi.openFolderDocked(folderPath, "right-panel");
      recordFolder(folderPath, "add");
      return;
    }
    const select = options?.select !== false; // default true
    const tabId = `folder:${folderPath}`;
    setFileTabs((prev) => openFolderTab(prev, { folderName, folderPath, tabId }));
    if (select) {
      setActiveFileTabId(tabId);
      revealFileTabOnOpen(); // user opened a folder → the tab bar follows it into view
      setRightPanelOpen(true);
      // Session restore (tombstone reopen) is owned by the rightPanelOpen effect above.
      if (isMobile) setSidebarOpen(false);
    }
    recordFolder(folderPath, "add");
  }, [isMobile, recordFolder, revealFileTabOnOpen]);

  // Right-panel empty state "open current working directory": open the CWD directly
  // when activeCwd exists; otherwise fetch the default working directory
  // (~/pi-cwd-YYYYMMDD, same semantics as the sidebar's "use default directory") and
  // open that — no directory picker is shown.
  const handleOpenCurrentWorkspace = useCallback(() => {
    if (activeCwd) {
      handleOpenFolder(activeCwd, getFileName(activeCwd));
      return;
    }
    void fetch(apiUrl("/api/default-cwd"), { method: "POST" })
      .then((res) => res.json())
      .then((data: { cwd?: string; error?: string }) => {
        if (data.cwd) {
          handleCwdChange(data.cwd, null, null);
          handleOpenFolder(data.cwd, getFileName(data.cwd));
        }
      })
      .catch(() => {});
  }, [activeCwd, handleCwdChange, handleOpenFolder]);

  // ── Generic primitives (policy-free): low-level tab count/pin/bulk-close
  //    capabilities for extensions ──
  // getFileTabs: return the list of currently open tabs (array order = open order).
  const handleGetFileTabs = useCallback(() =>
    // fileTabs excludes terminal tabs (terminals are stored separately in
    // terminalTabs); kind is narrowed to the two states declared by the host API.
    fileTabs.map((t) => ({ id: t.id, filePath: t.filePath, kind: (t.kind === "terminal" ? "file" : t.kind) ?? "file", pinned: t.pinned })),
  [fileTabs]);
  // closeFileTabs: remove from state only + re-seat activation; policies such as
  // dirty confirmation / pin protection are the caller's (extension's) responsibility.
  const handleCloseFileTabs = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    if (idSet.size === 0) return;
    setFileTabs((prev) => {
      const next = prev.filter((t) => !idSet.has(t.id));
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur && idSet.has(cur)) {
        const remaining = fileTabs.filter((t) => !idSet.has(t.id));
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      }
      return cur;
    });
  }, [fileTabs]);

  // Extension host common API registration (capabilities as-is, no interpretation;
  // AppShell stays message-free and enumeration-free)
  registerHostApi({
    openFile: handleOpenFile,
    openFolder: handleOpenFolder,
    revealDir: handleRevealDir,
    getFileTabs: handleGetFileTabs,
    closeFileTabs: handleCloseFileTabs,
    appendText: (text) => chatInputRef.current?.appendText(text),
    writeComposerValue: (text) => {
      const c = chatInputRef.current;
      if (!c) return false;
      c.setValueTracked(text);
      return true;
    },
    restoreComposerDraft: (draft) => {
      const c = chatInputRef.current;
      if (!c) return false; // composer not mounted: the caller must not consume the draft
      c.restoreDraft(draft);
      return true;
    },
  });

  // File open requested by the devtools extension (in-browser view — file tab):
  // "frontend open" clicked in a debug-target candidate detail
  useEffect(() => {
    const onAitiOpenFile = (e: MessageEvent) => {
      const m = e.data;
      if (m && m.__dbg === 1 && m.type === "aiti_open_file" && typeof m.payload?.filePath === "string") {
        handleOpenFile(m.payload.filePath, getFileName(m.payload.filePath), { sourceSessionId: selectedSession?.id ?? null });
      }
    };
    window.addEventListener("message", onAitiOpenFile);
    return () => window.removeEventListener("message", onAitiOpenFile);
  }, [handleOpenFile, selectedSession?.id]);

  /**
   * Async confirmation before closing/switching a file: the decision is handed to the
   * current viewer (the file-editor extension or another takeover owner). The core is
   * unaware of details like dirty state — it only calls the editor's
   * confirmClose(path) → Promise<boolean>; true = allow, false = block. Without a
   * confirmation capability (no takeover) the action is always allowed.
   */
  const askEditorClose = useCallback(async (filePath: string, isSwitch = false): Promise<boolean> => {
    try {
      const q = window.__aitiEditor?.confirmClose;
      if (typeof q !== "function") return true;
      return (await q(filePath, { isSwitch })) !== false;
    } catch {
      return true; // a confirmation error must not block closing
    }
  }, []);

  const guardedSelectFileTab = useCallback(async (tabId: string) => {
    if (tabId === activeFileTabId) return;
    const prevId = activeFileTabId;
    const cur = fileTabs.find((t) => t.id === prevId);
    // Ask first, switch later: only switch when the editor allows; if blocked, stay
    // on the original tab (avoids optimistic switching that unloads the viewer before
    // a rejection, losing content). Without a confirmation capability (no takeover)
    // the switch is allowed; folder tabs have no editing state (FolderViewer is not
    // owned by the file-editor extension) and switch directly.
    if (cur?.filePath && cur.kind !== "folder") {
      const ok = await askEditorClose(cur.filePath, true);
      if (!ok) return;
    }
    // User click/keyboard switch: bump the token so the tab bar scrolls the target
    // into view (a clicked target is usually already visible → no-op; only keyboard
    // Home/End jumps to an overflow tab actually scroll).
    revealFileTabOnOpen();
    // active may have been changed by another interaction while awaiting — switch
    // only if still resting on the original tab
    setActiveFileTabId((active) => (active === prevId ? tabId : active));
  }, [activeFileTabId, fileTabs, askEditorClose, revealFileTabOnOpen]);

  // [extension] T2 takeover: the sidebar "terminal" button → create a terminal tab (bridge
  // takeover prefers the command-terminal extension's shell, falling back to the
  // native PTY panel when absent — see TerminalPanelBridge); no longer connects to
  // the legacy command global directly (single entry point prevents double opens).
  const handleOpenTerminal = useCallback((cwd: string, forceNew?: boolean) => {
    const existing = forceNew ? undefined : terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    revealFileTabOnOpen(); // user opened a terminal tab → the tab bar follows it into view
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [terminalTabs, isMobile, revealFileTabOnOpen]);

  // closing finalization (upstream #695 semantics + local removal in takeover mode):
  // restart swaps in a new id in place once termination completes (wait for the old
  // process to die before creating the new one — docs/terminal.md Lifecycle); in
  // takeover mode there is no restart, so closing is always "close" (local removal
  // suffices; shell lifecycle belongs to the command-terminal extension).
  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const remaining = terminalTabs.filter((item) => item.id !== tab.id);
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    // Detached-window continuity: after a restart swaps the id, the window follows
    // the new id (otherwise the terminal would drop back into the right panel).
    if (replacement && detachedTabIds.has(tab.id)) {
      setDetachedTabIds((prev) => {
        const next = new Set(prev);
        next.delete(tab.id);
        next.add(replacement.id);
        return next;
      });
    }
    setActiveFileTabId((current) => current !== tab.id ? current : replacement?.id ?? remaining.at(-1)?.id ?? fileTabs.at(-1)?.id ?? null);
    if (!replacement && !remaining.length && !fileTabs.length) setRightPanelOpen(false);
  };

  // Native fallback layer: restart = finalize close with a restart marker
  // (TerminalPanel calls back above once termination completes); on close failure
  // (DELETE network failure etc.) clear the marker and keep the tab retryable.
  const handleTerminalRestart = (tabId: string) => {
    setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "restart" } : tab));
  };
  const handleTerminalCloseError = (tabId: string) => {
    setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && tab.closing ? { ...tab, closing: undefined } : tab));
  };

  const performCloseFileTab = useCallback((tabId: string) => {
    const closing = fileTabs.find((t) => t.id === tabId);
    if (closing?.kind === "folder" && closing.filePath) {
      recordFolder(closing.filePath, "remove");
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && terminalTabs.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? null;
    });
  }, [fileTabs, terminalTabs, recordFolder]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // dock tab (floating-dialog extension dock v0.5.0): ✕ = state-machine close
    // (command event, zero host state cleanup — dock tabs never enter
    // fileTabs/terminalTabs state; activation fallback is handled by the
    // present-change closed branch)
    if (tabId.startsWith("dock:")) {
      const key = tabId.slice(5);
      // File dock face (file-editor extension file-dock, 2026-09-16): ✕ = close file —
      // run the editor's dirty confirmation first (confirmClose true-close semantics;
      // dirty files get a custom dialog), and only send the close command once
      // allowed; instance removal / dockPref cleanup is finalized by the extension's
      // closed listener. Other dock tabs are sent straight through as before.
      if (key.startsWith("aiti-editor:file:")) {
        const facePath = key.slice("aiti-editor:file:".length);
        void askEditorClose(facePath).then((ok) => {
          if (!ok) return;
          try { window.dispatchEvent(new CustomEvent("piwe-float-present-command", { detail: { key, mode: "close" } })); } catch { /* ignore */ }
        });
        return;
      }
      try { window.dispatchEvent(new CustomEvent("piwe-float-present-command", { detail: { key, mode: "close" } })); } catch { /* ignore */ }
      return;
    }
    // terminal tabs go through closing finalization (bridge-local removal, see
    // handleTerminalClosed)
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    // file-editor close guard: asynchronously ask the file viewer whether closing is
    // allowed (folder tabs have no editing state and close directly)
    const closing = fileTabs.find((t) => t.id === tabId);
    if (closing?.kind !== "folder" && closing?.filePath) {
      void askEditorClose(closing.filePath).then((ok) => { if (ok) performCloseFileTab(tabId); });
      return;
    }
    performCloseFileTab(tabId);
  }, [fileTabs, terminalTabs, askEditorClose, performCloseFileTab]);

  // ═══ [floating-dialog extension tab-detach v0.6.0] detach / re-dock (plan §5.1) ═══
  const detachTab = useCallback((tabId: string) => {
    // Initial geometry = the right-panel content area's size at the detach instant
    // (the window grows in place); measured via ref before mount and stored in state.
    const rect = rightPanelContentRef.current?.getBoundingClientRect();
    setDetachInitGeom({ w: Math.round(rect?.width || 720), h: Math.round(rect?.height || 480) });
    setDetachedTabIds((prev) => prev.has(tabId) ? prev : new Set(prev).add(tabId));
    // Activation fallback: same algorithm as performCloseFileTab (remaining.at(-1)
    // within the panel, across file/terminal).
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remainingFiles = fileTabs.filter((t) => t.id !== tabId);
      const remainingTerms = terminalTabs.filter((t) => t.id !== tabId);
      return remainingFiles.at(-1)?.id ?? remainingTerms.at(-1)?.id ?? null;
    });
    // panelTabs fully empty → collapse the right panel (same semantics as "collapse
    // when the last tab closes"; the detached window persists, independent of the
    // right panel's open state).
    const remainingPanel = fileTabs.filter((t) => t.id !== tabId).length + terminalTabs.filter((t) => t.id !== tabId).length;
    if (remainingPanel === 0) setRightPanelOpen(false);
  }, [fileTabs, terminalTabs]);

  const dockBackTab = useCallback((tabId: string) => {
    setDetachedTabIds((prev) => {
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
    // Activate on return so the user sees it immediately (re-open the right panel +
    // activate the tab + scroll it into view).
    setActiveFileTabId(tabId);
    revealFileTabOnOpen();
    setRightPanelOpen(true);
  }, [revealFileTabOnOpen]);

  // TabBar double click: detaching a dock tab = the state machine's existing
  // present(k,"float") transition (zero new mechanisms, plan §5.8; the command-event
  // channel matches the handleCloseFileTab dock branch, the host imports no extension
  // code); file/folder/terminal = tabHost detach. The mobile right panel is an
  // overlay drawer where detach semantics tangle → disabled.
  const handleTabDoubleClick = useCallback((tab: Tab) => {
    if (tab.kind === "dock") {
      try { window.dispatchEvent(new CustomEvent("piwe-float-present-command", { detail: { key: tab.id.slice(5), mode: "float" } })); } catch { /* ignore */ }
      return;
    }
    if (isMobile || tab.closing) return;
    detachTab(tab.id);
  }, [detachTab, isMobile]);

  // File tab ⇱ "left panel · block / right panel · panel" (file dock face,
  // 2026-09-16): explicit docking — handed to the extension's dockFile (add instance →
  // close the host tab → present dock:zone). When the extension is absent the TabBar
  // does not render these two entries (the prop is always passed; absence = no-op).
  const handleDockFileTab = useCallback((tab: Tab, zone: "sidebar" | "right-panel") => {
    const dock = window.__aitiEditor?.dockFile;
    if (typeof dock !== "function" || !tab.filePath) return;
    dock(tab.filePath, zone);
  }, []);
  // ═══ [tab-detach handling end] ═══

  // TabBody host context (shared by the right panel and detached windows; handlers
  // are passed through unchanged, no policy differences).
  const tabBodyCtx: TabBodyCtx = {
    cwd: activeCwd ?? null,
    gitRefreshKey: explorerRefreshKey,
    panelOpen: rightPanelOpen,
    selectedSessionId: selectedSession?.id ?? null,
    onStateChange: handleFileViewerStateChange,
    onLineMention: handleFileLineMention,
    onAtMention: handleAtMention,
    openFile: handleOpenFile,
    openFolder: handleOpenFolder,
    onTerminalClosed: handleTerminalClosed,
    onTerminalRestart: handleTerminalRestart,
    onTerminalCloseError: handleTerminalCloseError,
    onOpenShellTab: (openCwd) => handleOpenTerminal(openCwd, true),
  };
  // Content dispatch target: looked up directly in the panelTabs derived surface
  // (detached excluded, dock tabs included — dock is not in fileTabs). Null when a
  // terminal is active (its always-mounted container handles it; see the hidden
  // container list below).
  const activeTabForBody: Tab | null = panelTabs.find((t) => t.id === activeFileTabId) ?? null;

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      apiUrl(`/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`),
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  const handleExportPrompts = useCallback(() => {
    if (!selectedSession) return;
    setExportDialogOpen(true);
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  // Target workspace chosen on the new-session page (unselected = current). Used only
  // as the target for session creation / models / trust checks; it does not
  // participate in the sidebar's selectedCwd sync — so the app workspace does not
  // switch immediately after choosing.
  const targetNewSessionCwd = newSessionWorkspace ?? effectiveNewSessionCwd;
  // Workspace dropdown candidates: recent projects (by activity) + the current cwd
  // (always present); add the staged target when it is missing from the list.
  const newSessionWorkspaceOptions = useMemo(() => {
    const options = getRecentProjects(sessionCatalog).map((p) => ({ key: p.key, root: p.root }));
    if (effectiveNewSessionCwd && !options.some((p) => p.root === effectiveNewSessionCwd)) {
      options.unshift({ key: effectiveNewSessionCwd, root: effectiveNewSessionCwd });
    }
    if (newSessionWorkspace && !options.some((p) => p.root === newSessionWorkspace)) {
      options.push({ key: newSessionWorkspace, root: newSessionWorkspace });
    }
    return options;
  }, [sessionCatalog, effectiveNewSessionCwd, newSessionWorkspace]);
  // Switch the target workspace: remount the composer (sessionKey) — if the old cwd's
  // runtime was already ensured (e.g. the system-prompt panel or slash-command list
  // was opened), it must not catch messages meant for the new workspace; drafts are
  // restored across mounts by the draft-keeper extension (on mount with the same
  // draftKey the keeper runs keyChange(first) + scan backfill).
  const handleNewSessionWorkspaceChange = useCallback((cwd: string | null) => {
    const next = cwd && cwd !== (newSessionCwd ?? activeCwd) ? cwd : null;
    if (next === newSessionWorkspace) return;
    setNewSessionWorkspace(next);
    setSessionKey((k) => k + 1);
  }, [activeCwd, newSessionCwd, newSessionWorkspace]);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? targetNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(apiUrl("/api/project-trust/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projectTrustCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setCwdMissingNotice(null);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Directory does not exist (a session directory that was moved/deleted):
        // surface a visible notice bar instead of only a console error
        const missing = /Directory does not exist/i.test(error instanceof Error ? error.message : String(error));
        if (missing) {
          setCwdMissingNotice(projectTrustCwd);
          return;
        }
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch(apiUrl("/api/project-trust"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  // -------------------------------------------------------------------------
  //  Top-bar tool buttons: custom order + hide + separators + "⋯" overflow
  //  (one unified mechanism, no per-screen-size branches). Pure logic lives in
  //  lib/topbar-order.ts (persistence + merge + separator normalization).
  // -------------------------------------------------------------------------
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const itemsRowRef = useRef<HTMLDivElement>(null);
  const measureStripRef = useRef<HTMLDivElement>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [moreRect, setMoreRect] = useState<{ top: number; right: number; topbarBottom: number } | null>(null);
  const [storedOrder, setStoredOrder] = useState<TopbarOrderItem[] | null>(null);
  const [storedHidden, setStoredHidden] = useState<TopbarItemId[]>([]);

  // hydration: localStorage is only readable after mount (SSR-safe); initial value
  // is the default order
  useEffect(() => {
    setStoredOrder(readTopbarOrder());
    setStoredHidden(readTopbarHidden() ?? []);
  }, []);

  // Extension slot items (flattened into the top-bar item list; ids reuse the
  // ext-ui-store extId:itemId convention)
  const toolbarExtItems = useExtSlotItems("toolbar");
  const sessionTopbarExtItems = useExtSlotItems("sessionTopbar");
  // Declarative static entries (no render) that lazy extensions place in
  // sidebarFooter: the host renders a standard bottom button; clicks go through
  // meta.onClick (staticClickForwarder → materialize → forward to the registered
  // item's behavior). Same rules as toolbar declarative items; after materialization
  // the registered item overrides the same id and the static entry retires naturally.
  const sidebarFooterStaticItems = useExtSlotItems("sidebarFooter").filter((it) => it.static && !hasExtRender(it));
  // Extension-level metadata (manifest name/icon) — used to label the extension in panels
  const extMetas = useExtMetas();

  const topbarBuiltinIds = useMemo<TopbarItemId[]>(() => {
    // "services" was extracted into an extension along with the tunnel panels
    // (extension items enter the top bar via toolbarExtItems)
    const ids: TopbarItemId[] = ["theme", "language"];
    if (showChat) ids.push("history", "export", "title", "branch", "system", "tools");
    return ids;
  }, [showChat]);
  const topbarToolbarExtIds = useMemo(
    () => toolbarExtItems.map((it) => it.id),
    [toolbarExtItems],
  );
  const topbarSessionExtIds = useMemo(
    () => sessionTopbarExtItems.map((it) => it.id),
    [sessionTopbarExtItems],
  );
  const topbarExtIds = useMemo<TopbarItemId[]>(() => {
    const seen = new Set<string>();
    const out: TopbarItemId[] = [];
    for (const it of [...toolbarExtItems, ...sessionTopbarExtItems]) {
      if (seen.has(it.id)) continue; // dedupe same id across slots (keep first occurrence)
      seen.add(it.id);
      out.push(it.id as TopbarItemId);
    }
    return out;
  }, [toolbarExtItems, sessionTopbarExtItems]);
  const availableIds = useMemo(
    () => [...topbarBuiltinIds, ...topbarExtIds],
    [topbarBuiltinIds, topbarExtIds],
  );
  const topbarDefaultOrder = useMemo<TopbarOrderItem[]>(
    () => [
      "theme", "language",
      // Session-level widgets (sessionTopbar: tags ★/chips/+) stay on the top-bar row
      // by design — "the chat top-bar tag area stays visible"; on narrow screens the
      // first overflowing ones become extension icon buttons (still reachable via ⋯)
      ...topbarSessionExtIds,
      ...topbarToolbarExtIds,
      "history", "export", "title", "branch", "system", "tools",
    ],
    [topbarToolbarExtIds, topbarSessionExtIds],
  );

  const layout = useMemo(
    () => resolveTopbarLayout(storedOrder, storedHidden, availableIds, topbarDefaultOrder),
    [storedOrder, storedHidden, availableIds, topbarDefaultOrder],
  );

  // Overflow measurement: the measure strip renders all visible items offscreen
  // (same layout, real widths); the row renders only [0..cutoffIndex]. useLayoutEffect
  // completes before paint, so there is no first-frame flicker.
  const visibleItems = layout.visible;
  const visibleKey = visibleItems.join("|");
  const [cutoffIndex, setCutoffIndex] = useState<number>(
    () => Math.max(0, visibleItems.length - 1),
  );
  useLayoutEffect(() => {
    const row = itemsRowRef.current;
    const strip = measureStripRef.current;
    if (!row || !strip) return;
    const measure = () => {
      const cutoff = row.clientWidth - 4; // 4px tolerance
      const children = Array.from(strip.children) as HTMLElement[];
      let last = -1;
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        if (el.offsetLeft + el.offsetWidth <= cutoff) last = i;
        else break;
      }
      setCutoffIndex((cur) => (cur === last ? cur : last)); // avoid a re-render loop
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [visibleKey]);

  const branchIndex = visibleItems.indexOf("branch");
  const branchOverflowed = branchIndex >= 0 && branchIndex > cutoffIndex;
  const overflowItems = visibleItems.slice(cutoffIndex + 1);

  // "⋯" popup positioning (anchored to the ⋯ button, expanding to the bottom-right)
  useEffect(() => {
    if (!moreOpen && !customizeOpen) return;
    const btn = moreBtnRef.current;
    if (!btn) return;
    const update = () => {
      const r = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      // Right-anchored: panel right edge hugs the button's right edge; clamped on
      // small screens so the left edge stays on-screen
      // (panel max width 300 + 8px margin → right cap vw-8-300)
      const right = Math.max(4, Math.min(vw - r.right + 4, vw - 8 - 300));
      const topbarBottom = topBarRef.current?.getBoundingClientRect().bottom ?? r.bottom;
      setMoreRect({ top: r.bottom + 4, right, topbarBottom });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(btn);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [moreOpen, customizeOpen]);

  // Top-bar clicks close the popup first (except the ⋯ button, which toggles it): the
  // overlay starts below the top bar so top-bar buttons (session stats included) stay
  // clickable — a click closes the ⋯/customize panel before running its own action.
  // ⚠ React 19: setState during the capture phase of a discrete event flushes
  // SYNCHRONOUSLY — closing the menu directly would unmount the menu DOM before the
  // click's target/bubble dispatch, killing the button's onClick (the click would do
  // nothing). Deferred with setTimeout 0 until the current click finishes, so the
  // button's own onClick runs first.
  useEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const onCapture = (e: MouseEvent) => {
      if (moreBtnRef.current?.contains(e.target as Node)) return;
      if (moreOpen || customizeOpen) {
        setTimeout(() => {
          setMoreOpen(false);
          setCustomizeOpen(false);
        }, 0);
      }
    };
    el.addEventListener("click", onCapture, true);
    return () => el.removeEventListener("click", onCapture, true);
  }, [moreOpen, customizeOpen]);

  // Esc: capture-phase interception closes dropdowns/panels while open (does not
  // trigger the global Esc stop-agent shortcut)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (moreOpen || customizeOpen || activeTopPanel) {
        e.stopPropagation();
        e.preventDefault();
        setMoreOpen(false);
        setCustomizeOpen(false);
        setActiveTopPanel(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [moreOpen, customizeOpen, activeTopPanel]);

  // Top-bar dropdown panels (session info/tools/branches/agents/system prompt/language):
  // any pointerdown outside the top bar collapses the panel (without swallowing the
  // event; the click still takes effect normally). The panel itself is a DOM child of
  // the top bar (position:fixed does not affect contains) → the contains check covers
  // it naturally; clicks inside the top bar do not close here — the buttons' own
  // toggle handles it (clicking the same button collapses / another button switches).
  useEffect(() => {
    if (!activeTopPanel) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (topBarRef.current?.contains(target)) return;
      setActiveTopPanel(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [activeTopPanel]);

  // ---- Panel actions (take effect immediately + persisted to localStorage) ----
  const persistOrder = useCallback((order: TopbarOrderItem[]) => {
    const normalized = normalizeTopbarOrder(order);
    setStoredOrder(normalized);
    writeTopbarOrder(normalized);
  }, []);
  const moveItem = useCallback((idx: number, dir: -1 | 1) => {
    const next = layout.order.slice();
    const to = idx + dir;
    if (to < 0 || to >= next.length) return;
    [next[idx], next[to]] = [next[to], next[idx]];
    persistOrder(next);
  }, [layout.order, persistOrder]);
  const toggleHidden = useCallback((id: TopbarItemId) => {
    const nextSet = new Set(layout.hidden);
    if (nextSet.has(id)) nextSet.delete(id);
    else nextSet.add(id);
    const next = [...nextSet];
    setStoredHidden(next);
    writeTopbarHidden(next);
  }, [layout.hidden]);
  const addSeparator = useCallback(() => {
    const order = layout.order;
    // Insert before the last button: appending at the end would be deleted by the
    // trailing-separator normalization; inserting between buttons makes it visible
    // immediately and survive (the user can then move it into place with ↑/↓)
    let lastButtonIdx = -1;
    for (let i = order.length - 1; i >= 0; i--) {
      if (order[i] !== SEPARATOR) { lastButtonIdx = i; break; }
    }
    const next = [...order];
    next.splice(lastButtonIdx >= 0 ? lastButtonIdx : order.length, 0, SEPARATOR);
    persistOrder(next);
  }, [layout.order, persistOrder]);
  const removeSeparator = useCallback((idx: number) => {
    const next = layout.order.slice();
    next.splice(idx, 1);
    persistOrder(next);
  }, [layout.order, persistOrder]);
  const resetTopbar = useCallback(() => {
    setStoredOrder(null);
    setStoredHidden([]);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(TOPBAR_ORDER_KEY);
        window.localStorage.removeItem(TOPBAR_HIDDEN_KEY);
      } catch {
        // ignore
      }
    }
  }, []);
  const closePopovers = useCallback(() => {
    setMoreOpen(false);
    setCustomizeOpen(false);
    setActiveTopPanel(null);
  }, []);
  const openCustomize = useCallback(() => {
    setMoreOpen(false);
    setCustomizeOpen(true);
  }, []);
  const handleMoreToggle = useCallback(() => {
    setCustomizeOpen(false);
    setActiveTopPanel(null);
    setMoreOpen((v) => !v);
  }, []);

  // ---- Top-bar button rendering (two shells: inline / ⋯ menu) ----
  const topbarMenuRowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8,
    width: "100%", height: 36, padding: "0 14px",
    background: "none",
    // longhands throughout: mixing with the inline buttons' borderRight/borderTop
    // longhands would otherwise trigger React's "removing shorthand (border) when
    // conflicting (borderRight)" warning
    borderLeft: "none", borderRight: "none", borderTop: "none", borderBottom: "none",
    color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 13,
  };
  // ⋯ menu icon slot: built-in item icons are wrapped in a 36px slot (right divider),
  // layout-identical to extension buttons (ExtComponent 36px + borderRight)
  const topbarMenuIconSlotStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 36, height: "100%", flexShrink: 0,
    borderRight: "1px solid var(--border)",
  };
  const topbarRowBtnStyle = (): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: "100%", padding: 0,
    background: "none", borderLeft: "none", borderTop: "none", borderBottom: "none",
    borderRight: "1px solid var(--border)",
    color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
  });
  const menuEnter = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = "var(--bg-hover)"; };
  const menuLeave = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = "transparent"; };
  const rowEnter = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--text)"; };
  const rowLeave = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--text-muted)"; };
  const act = (fn: () => void) => (menu: boolean) => () => {
    if (menu) setMoreOpen(false); // clicking inside ⋯ closes ⋯ first, then runs
    fn();
  };

  const renderTopbarItem = (id: string, inRow: boolean, forMeasure = false, forPreview = false): React.ReactNode => {
    const menu = !inRow;
    // Icons uniformly 16px: matches extension buttons (topbarBtnStyle fixed 16px), no
    // longer shrinks with isMobile
    const iconDim = 16;
    if (id === "theme") {
      const active = activeTopPanel === "theme";
      return (
        <button
          ref={!menu && !forMeasure ? themeBtnRef : undefined}
          type="button"
          onClick={act(() => toggleTopPanel("theme"))(menu)}
          title={translate(themeLabelKey)}
          aria-label={translate(themeLabelKey)}
          aria-haspopup="menu"
          aria-expanded={active}
          aria-pressed={active}
          style={menu
            ? { ...topbarMenuRowStyle, ...(active ? { background: "var(--bg-selected)", color: "var(--text)" } : {}) }
            : {
              ...topbarRowBtnStyle(),
              width: TOP_BAR_ICON_BUTTON_SIZE,
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
            }}
          onMouseEnter={menu ? menuEnter : rowEnter}
          onMouseLeave={menu ? menuLeave : rowLeave}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
            <ThemeIcon preference={preference} size={iconDim} />
          </span>
        </button>
      );
    }
    if (id === "language") {
      const active = activeTopPanel === "language";
      return (
        <button
          ref={!menu && !forMeasure ? languageBtnRef : undefined}
          type="button"
          onClick={act(() => toggleTopPanel("language"))(menu)}
          title={translate("common.language")}
          aria-label={translate("common.language")}
          aria-haspopup="menu"
          aria-expanded={active}
          aria-pressed={active}
          style={menu
            ? { ...topbarMenuRowStyle, ...(active ? { background: "var(--bg-selected)", color: "var(--text)" } : {}) }
            : {
              ...topbarRowBtnStyle(),
              width: TOP_BAR_ICON_BUTTON_SIZE,
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
            }}
          onMouseEnter={menu ? menuEnter : rowEnter}
          onMouseLeave={menu ? menuLeave : rowLeave}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
          <svg width={iconDim} height={iconDim} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 8 6 6" />
            <path d="m4 14 6-6 2-3" />
            <path d="M2 5h12" />
            <path d="M7 2h1" />
            <path d="m22 22-5-10-5 10" />
            <path d="M14 18h6" />
          </svg>
          </span>
        </button>
      );
    }
    if (id === "services") {
      return null; // the services button moved out with the tunnel panels extension (rendered via toolbarExtItems)
    }
    if (id === "history") {
      const disabled = !selectedSession;
      const labelBtn = menu ? { ...topbarMenuRowStyle, justifyContent: "flex-start" } : {
        display: "flex", alignItems: "center", gap: 6,
        height: "100%", padding: isMobile ? "0 8px" : "0 12px",
        background: "none", borderLeft: "none", borderTop: "none", borderBottom: "none",
        borderRight: "1px solid var(--border)",
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1, flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
        transition: "color 0.1s, background 0.1s, opacity 0.1s",
      };
      return (
        <button
          type="button"
          onClick={act(() => handleViewFullHistory())(menu)}
          disabled={disabled}
          title={selectedSession ? translate("history.full") : translate("history.unsaved")}
          aria-label={translate("history.full")}
          style={labelBtn}
          onMouseEnter={(e) => {
            if (disabled) return;
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = disabled ? "var(--text-dim)" : "var(--text-muted)";
            e.currentTarget.style.background = "none";
          }}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: disabled ? "var(--text-dim)" : "var(--text-muted)", flexShrink: 0 }}>
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
          </span>
          {!forPreview && <span>{translate("history.label")}</span>}
        </button>
      );
    }
    if (id === "export") {
      const disabled = !selectedSession;
      return (
        <button
          type="button"
          onClick={act(() => handleExportPrompts())(menu)}
          disabled={disabled}
          title={selectedSession ? translate("history.exportPrompts") : translate("history.unsaved")}
          aria-label={translate("history.exportPrompts")}
          style={menu ? { ...topbarMenuRowStyle, justifyContent: "flex-start" } : {
            display: "flex", alignItems: "center", gap: 6,
            height: "100%", padding: "0 12px",
            background: "none", borderLeft: "none", borderTop: "none", borderBottom: "none",
            borderRight: "1px solid var(--border)",
            color: disabled ? "var(--text-dim)" : "var(--text-muted)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.45 : 1, flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(e) => {
            if (disabled) return;
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = disabled ? "var(--text-dim)" : "var(--text-muted)";
            e.currentTarget.style.background = "none";
          }}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          </span>
          {!forPreview && <span>{translate("history.exportPrompts")}</span>}
        </button>
      );
    }
    if (id === "title") {
      const hasMessages = Boolean(
        selectedSession
        && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
      );
      const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
      const isSuccess = autoNameStatus.kind === "success";
      const isError = autoNameStatus.kind === "error";
      const label = autoNameStatus.kind === "naming"
        ? translate("title.generating")
        : isSuccess
          ? translate("title.updated")
          : isError
            ? translate("title.failed")
            : translate("title.generate");
      const title = !selectedSession
        ? translate("title.unsaved")
        : !hasMessages
          ? translate("title.noMessages")
          : isError
            ? autoNameStatus.message
            : translate("title.generateSession");
      return (
        <button
          type="button"
          onClick={act(() => void handleAutoName())(menu)}
          disabled={disabled}
          title={title}
          aria-label={label}
          style={menu ? { ...topbarMenuRowStyle, justifyContent: "flex-start" } : {
            display: "flex", alignItems: "center", gap: 6,
            height: "100%", padding: "0 12px",
            background: "none", borderLeft: "none", borderTop: "none", borderBottom: "none",
            borderRight: "1px solid var(--border)",
            color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
            flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(e) => {
            if (disabled) return;
            e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
            e.currentTarget.style.background = "none";
          }}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
          {autoNameStatus.kind === "naming" ? (
            <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : isSuccess ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 4 5 5L7 22l-5-5Z" />
              <path d="m14 5 5 5" />
              <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
            </svg>
          )}
          </span>
          {!forPreview && <span>{label}</span>}
        </button>
      );
    }
    if (id === "system") {
      const active = activeTopPanel === "system";
      return (
        <button
          type="button"
          onClick={act(() => toggleTopPanel("system"))(menu)}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={active}
          style={menu ? { ...topbarMenuRowStyle, ...(active ? { background: "var(--bg-selected)", color: "var(--text)" } : {}) } : {
            display: "flex", alignItems: "center", gap: 6,
            height: "100%", padding: "0 12px",
            background: active ? "var(--bg-selected)" : "none",
            borderLeft: "none",
            borderBottom: "none",
            borderTop: "none",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: active ? "var(--text)" : "var(--text-muted)",
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={menu ? menuEnter : rowEnter}
          onMouseLeave={menu ? menuLeave : rowLeave}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
            <span style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </svg>
            </span>
          </span>
          {!forPreview && <span>{translate("system.label")}</span>}
        </button>
      );
    }
    if (id === "tools") {
      const active = activeTopPanel === "tools";
      return (
        <button
          type="button"
          onClick={act(() => handleSystemInfoToggle("tools"))(menu)}
          title={translate("tools.title")}
          aria-label={translate("tools.title")}
          aria-pressed={active}
          style={menu ? { ...topbarMenuRowStyle, ...(active ? { background: "var(--bg-selected)", color: "var(--text)" } : {}) } : {
            display: "flex", alignItems: "center", gap: 6,
            height: "100%", padding: "0 12px",
            background: active ? "var(--bg-selected)" : "none",
            borderLeft: "none",
            borderBottom: "none",
            borderTop: "none",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: active ? "var(--text)" : "var(--text-muted)",
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={menu ? menuEnter : rowEnter}
          onMouseLeave={menu ? menuLeave : rowLeave}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
            <span style={{ color: systemTools?.some((tool) => tool.active) ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
              </svg>
            </span>
          </span>
          {!forPreview && <span>{translate("tools.label")}</span>}
        </button>
      );
    }
    if (id === "branch") {
      if (menu) {
        return (
          <button
            type="button"
            onClick={act(() => toggleTopPanel("branches"))(menu)}
            aria-pressed={activeTopPanel === "branches"}
            title={translate("i18n.branches")}
            style={topbarMenuRowStyle}
            onMouseEnter={menuEnter}
            onMouseLeave={menuLeave}
          >
            <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            </span>
            <span>{translate("i18n.branches")}</span>
          </button>
        );
      }
      if (forPreview) {
        // Panel preview: render only the branch icon (BranchNavigator is a full
        // component; embedding it in a small preview is not appropriate)
        return (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: "0 12px" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </div>
        );
      }
      return (
        <BranchNavigator
          tree={branchTree}
          activeLeafId={branchActiveLeafId}
          onLeafChange={handleBranchLeafChange}
          inline
          compact={isMobile}
          containerRef={topBarRef}
          open={activeTopPanel === "branches"}
          onToggle={() => toggleTopPanel("branches")}
          hasSession
        />
      );
    }
    // Extension items: rendered as React elements (same as ExtSlot), otherwise the
    // hooks inside extension components (ctx.useState etc.) would be injected into
    // AppShell's hook sequence → runtime error
    const toolbarItem = toolbarExtItems.find((it) => it.id === id);
    const sessionItem = sessionTopbarExtItems.find((it) => it.id === id);
    const extItem = toolbarItem ?? sessionItem;
    if (!extItem) return null;
    const ExtComponent = extItem.render as React.ComponentType<ExtRenderProps>;
    // toolbar, like sessionTopbar, passes down newSessionCwd (extensions such as the
    // plan-first extension need a cwd during the new-session phase: pick a plan/doc
    // first, auto-bound once the session is created); extensions that don't consume
    // it just receive one extra prop, no impact.
    const extProps = { currentSession: selectedSession, newSessionCwd: effectiveNewSessionCwd };
    // ⚠ Extension render components must be mounted exactly once, only where actually used:
    //   forMeasure (offscreen measure strip) / forPreview (customize-panel preview) never
    //   mount them; placeholders are rendered instead.
    //   (Otherwise 2-3 instances of an extension component mount at once and every
    //     effect runs multiple times — the read-along "auto read" effect of the voice
    //     extension once double-started with two instances and played double audio;
    //     singleton guards like barSlotTaken only mitigate, they are not the root fix.)
    if (forMeasure) {
      // Offscreen measurement: fixed 36px placeholder (= standard extension button
      // width TOP_BAR_ICON_BUTTON_SIZE). Portal-style components (e.g. a voice
      // playback bar) take no inline width anyway; an error of ≤36px only slightly
      // affects overflow clipping.
      return (
        <div aria-hidden style={{
          width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }} />
      );
    }
    if (forPreview) {
      // Customize panel 30px icon preview: meta icon (same as the ⋯ menu icon slot) or
      // a neutral placeholder; the component is not mounted.
      const pIcon = extItem.meta?.icon;
      return (
        <div aria-hidden style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 16 }}>
          {pIcon != null
            ? <>{renderExtItemIcon(pIcon, extItem.extId)}</>
            : <span style={{ width: 10, height: 10, border: "2px solid var(--text-dim, #999)", borderRadius: 3, opacity: 0.7 }} />}
        </div>
      );
    }
    if (menu) {
      // Two forms for extension items in the ⋯ dropdown:
      //  a) Declarative icon form: meta.icon + meta.onClick (2026-08 contract, no
      //     render), or a render item that also carries meta.onClick (clicks go to
      //     meta.onClick, the render is not mounted) — the icon slot is rendered by
      //     the host (topbarMenuIconSlotStyle, same as built-in items).
      //     Only "has meta.onClick or has no render" takes this form: self-drawn items
      //     with a render but no meta.onClick (e.g. session-manager
      //     sessions/kanban/search) that also draw only an icon would leave the menu
      //     row without any clickable target (metaOnClick missing, delegateClick finds
      //     no inner button) → clicks do nothing (fixed 2026-09).
      //  b) Self-drawn component (legacy contract / interactive widget): embedded
      //     as-is (menu=true) with meta.label text added, aligned with built-in items;
      //     clicks delegate to the inner button (delegateClick)
      const extItem2 = toolbarItem ?? sessionItem;
      const metaIcon = extItem2?.meta?.icon;
      const metaOnClick = extItem2?.meta?.onClick;
      const declarativeIcon = metaIcon != null
        && (typeof metaOnClick === "function" || typeof ExtComponent !== "function");
      // noMenuLabel: the extension already provides full content in the ⋯ menu (e.g.
      // a search input + button); the host adds no text label
      const label = extItem2 && !extItem2.meta?.noMenuLabel
        ? (extItem2.meta?.label ?? extItem2.meta?.title ?? id)
        : null;
      // Whole row clickable: the extension's inner button carries the action; clicks
      // on text/blank areas delegate to it (same as built-in items' full-row button).
      // Layout unified with built-in items: topbarMenuRowStyle (height 36 +
      // padding 0 14px + gap 8), no divider in the middle
      const delegateClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // input/textarea (e.g. a search box inside ⋯) handle their own clicks: no
        // delegation, no menu close
        if ((e.target as HTMLElement).closest("button, [role='button'], input, textarea")) return;
        const inner = e.currentTarget.querySelector<HTMLElement>("button, [role='button']");
        if (inner) inner.click();
      };
      return (
        <div
          role="menuitem"
          onClick={(e) => {
            if (typeof metaOnClick === "function") { metaOnClick(e); return; }
            delegateClick(e);
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          style={{ ...topbarMenuRowStyle, justifyContent: "flex-start" }}
        >
          {declarativeIcon ? (
            <span style={{ ...topbarMenuIconSlotStyle, color: "var(--text-muted)" }} aria-hidden>
              {renderExtItemIcon(metaIcon, extItem2?.extId)}
            </span>
          ) : typeof ExtComponent === "function" ? (
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              {/* menu flag: extensions can switch rendering in the menu context
                  (e.g. session-manager's search box → icon + text only in the menu) */}
              <ExtItemBoundary extId={extItem.extId} slot={toolbarItem ? "toolbar" : "sessionTopbar"} itemId={`${id}/menu`}>
                <ExtComponent {...extProps} menu />
              </ExtItemBoundary>
            </div>
          ) : (
            /* [lazy-load v2] Fallback for declarative static items (no render) without
               an icon: label's first character as placeholder (ExtComponent is not
               mounted — undefined would blow up the React element tree; icons are
               required by the SOP, the placeholder is a fallback only) */
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, flexShrink: 0, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }} aria-hidden>
              {(extItem2?.meta?.label ?? extItem2?.meta?.title ?? "?").slice(0, 1)}
            </span>
          )}
          {label && (
            <span style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {label}
            </span>
          )}
        </div>
      );
    }
    // Declarative toolbar item (meta.icon + meta.onClick, no render): the host renders
    // a standard 36×36 grayscale button; only the toolbar slot takes this path —
    // sessionTopbar widgets must provide a render
    if (toolbarItem && !toolbarItem.render) {
      return <ExtToolbarIconButton item={toolbarItem} />;
    }
    if (!extItem.render) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <ExtItemBoundary extId={extItem.extId} slot={toolbarItem ? "toolbar" : "sessionTopbar"} itemId={id}>
          <ExtComponent {...extProps} menu={false} />
        </ExtItemBoundary>
      </div>
    );
  };

  const sepNode = (idx: number): React.ReactNode => (
    <div
      key={`sep:${idx}`}
      data-topbar-sep
      style={{ width: 1, height: "55%", alignSelf: "center", background: "var(--border)", margin: "0 6px", flexShrink: 0 }}
    />
  );
  const entryNode = (item: TopbarOrderItem, idx: number): React.ReactNode =>
    item === SEPARATOR
      ? sepNode(idx)
      : (
        <div key={item} data-topbar-id={item} style={{ display: "flex", alignItems: "stretch", flexShrink: 0, height: "100%" }}>
          {renderTopbarItem(item, true)}
        </div>
      );
  const rowEntryNodes = visibleItems.slice(0, cutoffIndex + 1).map(entryNode);
  const stripEntryNodes = visibleItems.map((item, idx) => (
    <div key={idx} style={{ display: "flex", alignItems: "stretch", flexShrink: 0 }}>
      {item === SEPARATOR ? sepNode(idx) : renderTopbarItem(item, true, true)}
    </div>
  ));
  const overflowMenuNodes = overflowItems.map((item) =>
    item === SEPARATOR ? null : (
      // Button items: close ⋯ in the capture phase first (built-in onClick also
      // closes, idempotent; this covers extension buttons' internal onClick);
      // session-level widgets (sessionTopbar slot) are interactive components whose
      // internal dialogs depend on the component staying alive — the click must not
      // close ⋯, otherwise the widget unmounts with ⋯ and the dialog vanishes
      // instantly ("+" add-tag becomes ineffective).
      // ⚠ React 19 sync-flush fix: setMoreOpen directly in the capture phase unmounts
      // the menu before the click's target dispatch (button onClick lost → click does
      // nothing) — deferred until after the event handler.
      <div
        key={item}
        onClickCapture={sessionTopbarExtItems.some((it) => it.id === item)
          ? undefined
          : (e) => { if ((e.target as HTMLElement).closest("input, textarea")) return; setTimeout(() => setMoreOpen(false), 0); }}
      >
        {renderTopbarItem(item, false)}
      </div>
    ),
  );

  // ---- Reorder/hide/separator panel ----
  const extLabel = (id: string): string => {
    const toolbarItem = toolbarExtItems.find((it) => it.id === id);
    const sessionItem = sessionTopbarExtItems.find((it) => it.id === id);
    const it = toolbarItem ?? sessionItem;
    return it?.meta?.label ?? it?.meta?.title ?? id;
  };
  const topbarItemLabel = (id: TopbarItemId): string => {
    switch (id) {
      case "theme": return translate("topbar.theme");
      case "language": return translate("common.language");
      case "history": return translate("history.label");
      case "export": return translate("history.exportPrompts");
      case "title": return translate("title.generate");
      case "branch": return translate("i18n.branches");
      case "system": return translate("system.label");
      case "tools": return translate("tools.label");
      default: return extLabel(id);
    }
  };
  const panelArrowBtnStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 22, height: 16, padding: 0, border: "none", background: "none",
    color: "var(--text-muted)", cursor: "pointer", borderRadius: 4,
  };
  const panelSmallBtnStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 26, height: 26, padding: 0, border: "none", background: "none",
    color: "var(--text-muted)", cursor: "pointer", borderRadius: 4, flexShrink: 0,
  };
  const panelFooterBtnStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "8px 14px", background: "none", border: "none",
    color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
  };
  const panelMoveButtons = (idx: number, total: number): React.ReactNode => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => moveItem(idx, -1)}
        disabled={idx === 0}
        title={translate("topbar.moveUp")}
        aria-label={translate("topbar.moveUp")}
        style={panelArrowBtnStyle}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 6.5 5 3.5 8 6.5" /></svg>
      </button>
      <button
        type="button"
        onClick={() => moveItem(idx, 1)}
        disabled={idx === total - 1}
        title={translate("topbar.moveDown")}
        aria-label={translate("topbar.moveDown")}
        style={panelArrowBtnStyle}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 3.5 5 6.5 8 3.5" /></svg>
      </button>
    </div>
  );

  // ── Left-panel bottom row (models/skills/settings + sidebarFooter extension point):
  //    fallback state renders directly; takeover state goes through the
  //    renderSidebarFooter factory (unified dock plan §3.4 component-factory contract) ──
  const sidebarFooterRow = (
    <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
      {([
        ["models", translate("common.models")],
        ["skills", translate("common.skills")],
      ] as const).map(([section, label]) => {
        const disabled = section !== "models" && !projectTrustCwd;
        return (
          <button
            key={section}
            type="button"
            onClick={() => setSettingsSection(section)}
            disabled={disabled}
            title={disabled ? translate("settings.projectRequired") : label}
            aria-label={label}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 32, padding: 0, background: "none", border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
            <span>{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
        title={translate("common.settings")}
        aria-label={translate("common.settings")}
        style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          height: 32, padding: 0, background: "none", border: "none",
          borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
          fontSize: 12, transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
        <span>{translate("common.settings")}</span>
      </button>
      {/* Lazy-extension declarative entries (static items with no render) — same row
          and same style as the built-in buttons; clicking brings up the extension via
          meta.onClick and runs its original behavior (e.g. the extension manager
          opening its management panel). */}
      {sidebarFooterStaticItems.map((it) => {
        const label = it.meta?.label ?? it.meta?.title ?? it.extId ?? "?";
        return (
          <button
            key={it.id}
            type="button"
            onClick={(event) => it.meta?.onClick?.(event)}
            disabled={it.pending === true}
            title={it.meta?.title ?? label}
            aria-label={label}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 32, padding: 0, background: "none", border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: it.pending ? "default" : "pointer",
              fontSize: 12, opacity: it.pending ? 0.5 : 1, transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {renderExtItemIcon(it.meta?.icon, it.extId) ?? (
              <span aria-hidden style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, fontSize: 12, fontWeight: 600 }}>
                {label.slice(0, 1)}
              </span>
            )}
            <span>{label}</span>
          </button>
        );
      })}
      {/* Extension point: sidebar footer quick-action row (same row as the built-in
          models/skills/settings; the extension-manager extension provides its management
          entry here) */}
      <ExtSlot name="sidebarFooter" />
    </div>
  );

  // ── Whole-left-panel takeover contract (sidebar unified dock plan §3.4): extra is
  //    passed through TakeoverSlot to the sidebarContent taker (the sessions extension's
  //    SidebarContentDock) — the component factory emits host elements directly (with a
  //    single render instance, element.type being a host component reference is
  //    naturally legal), with data/callbacks passed through in full; in takeover state
  //    the host SessionSidebar is not rendered. Fallback state = fallback (original
  //    sidebar). ──
  const sidebarContentExtra: Record<string, unknown> = {
    // Component factories
    renderTitle: () => <PiWebTitle />,
    renderSidebarFooter: () => sidebarFooterRow,
    // Session data
    selectedSession,
    selectedSessionId: selectedSession?.id ?? null,
    selectedCwd: selectedSession?.cwd ?? newSessionCwd ?? null,
    newSessionCwd: effectiveNewSessionCwd,
    refreshKey,
    explorerRefreshKey,
    sessionListVersion: null,
    // Initial restore (URL ?session= / default project auto-pick)
    initialSessionId,
    skipInitialProjectSelection: initialNavigation.requestedCwd !== null,
    // Navigation callbacks
    onSelectSession: handleSelectSession,
    onNewSession: handleNewSession,
    onOpenById: handleOpenSession,
    onSessionDeleted: handleSessionDeleted,
    onCwdChange: handleCwdChange,
    onOpenFile: handleOpenFile,
    onOpenFolder: handleOpenFolder,
    onOpenTerminal: handleOpenTerminal,
    onAtMention: handleAtMention,
    onAtMentions: handleAtMentions,
    onExplorerRefresh: handleExplorerRefresh,
    onInitialRestoreDone: handleInitialRestoreDone,
    onBackgroundTaskDone: handleBackgroundTaskDone,
    onRunningSessionIdsChange: handleRunningSessionIdsChange,
    onSessionsChange: handleSessionsChange,
    // State/tools
    translate,
    settingsSection,
    setSettingsSection,
    isMobile,
    // Collapse callback for the small-screen full-screen drawer (used by the taker's
    // header collapse button; desktop has no drawer and ignores it)
    onCloseSidebar: () => setSidebarOpen(false),
  };

  // ── §7-4 host component-factory registry (as a ctx service): the same contract as
  //    the sidebarContent extra, exposed to all extensions through the "pi-web.ui"
  //    service — consumers call getExtService("pi-web.ui") and fetch a factory by name.
  //    The impl delegates to the latest render closure via a ref (AppShell refreshes
  //    the ref on every render; the service registers only once on mount), avoiding
  //    a stale closure registration; unregistered on unmount. ──
  const hostUiRef = useRef<Record<string, unknown>>({});
  hostUiRef.current = { ...sidebarContentExtra, sidebarFooterRow, onLineMention: handleFileLineMention, closeTopPanels };
  useEffect(() => {
    return registerExtClientService(HOST_UI_SERVICE.provider, HOST_UI_SERVICE.name, {
      /** Fetch a host factory by name (renderTitle/renderSidebarFooter/callbacks …
       *  — the same set as the sidebarContent extra). */
      get: (name: string) => hostUiRef.current[name],
      /** List of factory names. */
      names: () => Object.keys(hostUiRef.current),
    });
  }, []);

  const sidebarContent = (
    <TakeoverSlot
      name="sidebarContent"
      legacyKey="pi-web:sessions-takeover"
      fallback={
        <>
          <SessionSidebarLazy
            selectedSessionId={selectedSession?.id ?? null}
            selectedSession={selectedSession}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            initialSessionId={initialSessionId}
            skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
            onInitialRestoreDone={handleInitialRestoreDone}
            onOpenById={handleOpenSession}
            refreshKey={refreshKey}
            onSessionDeleted={handleSessionDeleted}
            selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
            onCwdChange={handleCwdChange}
            onOpenFile={handleOpenFile}
            onOpenFolder={handleOpenFolder}
            onOpenTerminal={handleOpenTerminal}
            explorerRefreshKey={explorerRefreshKey}
            onExplorerRefresh={handleExplorerRefresh}
            onAtMention={handleAtMention}
            onAtMentions={handleAtMentions}
            fileExplorerRef={fileExplorerRef}
            onBackgroundTaskDone={handleBackgroundTaskDone}
            onRunningSessionIdsChange={handleRunningSessionIdsChange}
            onSessionsChange={handleSessionsChange}
          />
          {sidebarFooterRow}
        </>
      }
      extra={sidebarContentExtra}
    />
  );

  const renderThemeButton = (mobile: boolean) => (
    <button
      ref={themeBtnRef}
      type="button"
      onClick={() => toggleTopPanel("theme", mobile)}
      title={translate(themeLabelKey)}
      aria-label={translate(themeLabelKey)}
      aria-haspopup="menu"
      aria-expanded={activeTopPanel === "theme"}
      aria-pressed={activeTopPanel === "theme"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: activeTopPanel === "theme" ? "var(--bg-selected)" : "none",
        border: "none", borderRight: "1px solid var(--border)",
        color: activeTopPanel === "theme" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = activeTopPanel === "theme" ? "var(--text)" : "var(--text-muted)"; }}
      data-mobile-toolbar-action={mobile ? "theme" : undefined}
    >
      <ThemeIcon preference={preference} size={16} />
    </button>
  );



  const renderLanguageButton = (mobile: boolean) => (
    <button
      ref={languageBtnRef}
      type="button"
      onClick={() => toggleTopPanel("language", mobile)}
      title={translate("common.language")}
      aria-label={translate("common.language")}
      aria-haspopup="menu"
      aria-expanded={activeTopPanel === "language"}
      aria-pressed={activeTopPanel === "language"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
        border: "none", borderRight: "1px solid var(--border)",
        color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
      }}
      data-mobile-toolbar-action={mobile ? "language" : undefined}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </svg>
    </button>
  );

  const renderChatToolbarActions = (mobile: boolean) => {
    if (!mobile && !showChat) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <button
          type="button"
          onClick={() => {
            handleViewFullHistory();
            if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
          }}
          disabled={!selectedSession}
          title={selectedSession ? translate("history.full") : translate("history.unsaved")}
          aria-label={translate("history.full")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%",
            padding: mobile ? 0 : "0 12px",
            background: "none",
            border: "none",
            borderTop: "2px solid transparent",
            borderRight: "1px solid var(--border)",
            color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
            cursor: selectedSession ? "pointer" : "not-allowed",
            opacity: selectedSession ? 1 : 0.45,
            flexShrink: 0,
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!selectedSession) return;
            event.currentTarget.style.color = "var(--text)";
            event.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
            event.currentTarget.style.background = "none";
          }}
          data-mobile-toolbar-action={mobile ? "history" : undefined}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
          {!mobile && <span>{translate("history.label")}</span>}
        </button>
        {(() => {
          // After a context compaction the current messages may no longer contain a
          // user message, so also consult the session file's total message count.
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !selectedSession || selectedSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
              }}
              disabled={disabled}
              title={title}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                height: "100%", padding: mobile ? 0 : "0 12px",
                background: "none", border: "none",
                borderTop: "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              data-mobile-toolbar-action={mobile ? "name" : undefined}
            >
              {autoNameStatus.kind === "naming" ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 4 5 5L7 22l-5-5Z" />
                  <path d="m14 5 5 5" />
                  <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                </svg>
              )}
              {!mobile && <span>{label}</span>}
            </button>
          );
        })()}
        {hasSubagentSessions && (
          <button
            type="button"
            onClick={() => toggleTopPanel("agents", mobile)}
            title={translate("agentSwitcher.title")}
            aria-label={translate("agentSwitcher.title")}
            aria-pressed={activeTopPanel === "agents"}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
            {!mobile && <span>{translate("agentSwitcher.title")}</span>}
            <span
              aria-hidden="true"
              style={{
                minWidth: 15, height: 15, padding: "0 4px", display: "grid", placeItems: "center",
                borderRadius: 7, background: "var(--bg-selected)", color: "var(--accent)",
                fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
                ...(mobile ? { position: "absolute", top: 2, right: 2, minWidth: 13, height: 13, padding: "0 3px", fontSize: 9 } : {}),
              }}
            >
              {activeSessionFamily!.subagents.length}
            </span>
          </button>
        )}
        {sessionHasBranches && (mobile ? (
          <button
            type="button"
            onClick={() => toggleTopPanel("branches", true)}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={activeTopPanel === "branches"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "branches" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            data-mobile-toolbar-action="branches"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: branchTree.length > 0 ? "var(--accent)" : "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        ) : (
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            inline
            containerRef={topBarRef}
            open={activeTopPanel === "branches"}
            onToggle={() => toggleTopPanel("branches")}
            hasSession
          />
        ))}
        <button
          ref={systemBtnRef}
          type="button"
          onClick={() => handleSystemInfoToggle("system", mobile)}
          disabled={mobile && !showChat}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={activeTopPanel === "system"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "system" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
          {!mobile && <span>{translate("system.label")}</span>}
        </button>
        <button
          type="button"
          onClick={() => handleSystemInfoToggle("tools", mobile)}
          disabled={mobile && !showChat}
          title={translate("tools.title")}
          aria-label={translate("tools.title")}
          aria-pressed={activeTopPanel === "tools"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "tools" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "tools" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "tools" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemTools?.some((tool) => tool.active) ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
          </svg>
          {!mobile && <span>{translate("tools.label")}</span>}
        </button>
      </div>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    return (
      <button
        type="button"
        onClick={handleRightPanelToggle}
        disabled={covered}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        aria-hidden={covered ? true : undefined}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !mobile && !sessionStats && !contextUsage ? "auto" : 0,
          // The top-bar container reserves 44px at the top-right corner (file-toggle
          // placeholder + safe area); this button is the owner of that corner — a
          // negative right margin cancels the reserved padding so the button hugs the
          // container's right end (top-right). Desktop/mobile share the same container
          // and the same reservation, keeping the accounting consistent.
          marginRight: "calc(-44px - min(env(safe-area-inset-right), 8px))",
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: rightPanelOpen ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  // ── Small-screen system back = close the topmost overlay (does not leave the site /
  //    exit the PWA directly) ────────────────────────────────────────────────────────
  // lib/overlay-back.ts is the single writer of the history back stack (same source as
  // the pi-web.overlayBack service); each open state registers one back layer and close
  // is the original close action. Desktop (≥641px) does not participate: the browser
  // back semantics stay untouched. Declaration order equals effect order within the
  // same commit, so both close-old-then-open-new orders are safe (see plan §3.1).
  useOverlayBack(isMobile && mobileSidebarReady && sidebarOpen, () => setSidebarOpen(false));
  useOverlayBack(isMobile && rightPanelOpen, () => setRightPanelOpen(false));
  useOverlayBack(isMobile && settingsSection !== null, () => setSettingsSection(null));
  useOverlayBack(isMobile && projectTrustDialogOpen, () => setProjectTrustDialogOpen(false));
  useOverlayBack(isMobile && exportDialogOpen, () => setExportDialogOpen(false));
  useOverlayBack(isMobile && mobileToolbarMoreOpen, () => setMobileToolbarMoreOpen(false));
  useOverlayBack(isMobile && (moreOpen || customizeOpen), () => {
    setMoreOpen(false);
    setCustomizeOpen(false);
  });
  useOverlayBack(isMobile && activeTopPanel !== null, () => setActiveTopPanel(null));
  useOverlayBack(isMobile && bridgedNameDialog !== null, () => setBridgedNameDialog(null));

  return (
    <ExtSlotsProvider serverSlotDeclarations={extSlotDeclarations}>
    <>
    {cwdMissingNotice && (
      <div
        role="alert"
        style={{
          position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 300,
          display: "flex", alignItems: "center", gap: 10,
          maxWidth: "min(640px, 92vw)", padding: "10px 14px",
          background: "var(--bg-panel)", border: "1px solid #f59e0b88", borderRadius: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)", fontSize: 12.5, color: "var(--text)",
        }}
      >
        <span style={{ fontSize: 14 }}>📂</span>
        <span style={{ minWidth: 0, wordBreak: "break-all" }}>
          <strong>Directory does not exist: </strong>{cwdMissingNotice}
          <span style={{ color: "var(--text-muted)" }}>— it may have been moved or deleted (sessions from it are kept). Switch to a valid directory in the sidebar before creating a new session.</span>
        </span>
        <button
          type="button"
          onClick={() => setCwdMissingNotice(null)}
          title="Close"
          style={{ flexShrink: 0, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
        >
          ×
        </button>
      </div>
    )}
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        overflow: clip; /* clip creates no scroll container: the inner sticky top bar's relative scroll container is the outer dropdown (sticky never moves while hidden) */
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div
      className="app-shell-row"
      style={{
      display: "flex",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      /* The safe-area padding layer is managed by .app-shell-row (globals.css) instead:
         <641 keeps env(safe-area-inset-*) for the single-column mobile layout, ≥641
         multi-column layout zeroes it — on pads the system-reported 38px right gesture
         area would pad out the whole three-column layout, exposing a blank background
         strip on the right (measured on a portrait pad at 777px: pad=[0,38], the main
         column was squeezed 38px, "missing a chunk"; the insets differ between
         orientation switches). In multi-column the content has its own margins (the
         chat column centers itself with max-w + the right panel applies its own
         right:env()), so no container-level padding layer is needed. */
      overflow: "hidden",
      background: "var(--bg)",
    }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        inert={rightPanelFullWidth}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          inert={rightPanelFullWidth}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div inert={rightPanelFullWidth} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div
          ref={topBarRef}
          style={{
            display: "flex", alignItems: "center", flexShrink: 0,
            // The divider is drawn with an inset box-shadow (takes no layout space):
            // with global box-sizing: border-box, a 1px border would eat 1px of the
            // content area → the container had to be 37px; with the inset shadow the
            // container height returns to the 36px baseline and the content area is
            // exactly 36px, isomorphic with buttons/icon slots/extensions.
            borderBottom: "none",
            boxShadow: "inset 0 -1px 0 var(--border)",
            height: "calc(36px + env(safe-area-inset-top))",
            paddingTop: "env(safe-area-inset-top)",
            background: "var(--bg-panel)",
            overflowX: "hidden",
            overflowY: "hidden",
            // The top-right fixed file-panel toggle (36px + gap) would cover the right
            // end; reserved padding prevents that. Plus the safe area (measured 38px on
            // pads): after the button's margin-right avoids the gesture area it
            // actually occupies safe-area+36+gap, so padding counts only 36+8 — avoids
            // the chat column's right side being clipped another 38px on pads (the
            // last source of "a big blank on the right").
            paddingRight: "calc(44px + min(env(safe-area-inset-right), 8px))",
          }}
        >
          <button
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: "none", borderLeft: "none", borderTop: "none", borderBottom: "none",
              borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {/* Sortable/hideable/separable tool button row: the row renders only what
              fits; the offscreen strip is used for measurement */}
          <div
            ref={itemsRowRef}
            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "stretch", height: "100%", overflowX: "hidden", position: "relative" }}
          >
            {rowEntryNodes}
            <div
              ref={measureStripRef}
              aria-hidden="true"
              style={{ position: "absolute", left: -100000, top: 0, display: "flex", alignItems: "stretch", pointerEvents: "none", visibility: "hidden" }}
            >
              {stripEntryNodes}
            </div>
          </div>
          {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={translate("trust.resourcesNotLoaded")}
              aria-label={translate("trust.resourcesNotLoaded")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: "100%",
                padding: isMobile ? "0 10px" : "0 12px",
                background: "none",
                borderLeft: "none", borderTop: "none", borderBottom: "none",
                borderRight: "1px solid var(--border)",
                color: "#d97706",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 11,
                whiteSpace: "nowrap",
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
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
            </button>
          )}
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
             const tokens = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? fmtMoney(c, 2) : fmtMoneySmall()) : null;

            // Single source of truth for the urgency color scale: lib/context-urgency.ts
            // (the top bar is the scale baseline; the critical tier gets the breathe animation)
            const ctxUrg = contextUrgency(contextUsage?.contextWindow ? contextUsage.percent : null);
            const ctxColor = ctxUrg.color;
            const ctxBreathe = ctxUrg.level === "critical" ? CTX_BREATHE_CSS : undefined;
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
             if (tokens) {
               tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
               tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
               tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
               tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
              if (c > 0) tooltipParts.push(`cost: ${fmtMoney(c, 4)}${fxNote() ? ` · ${fxNote()}` : ""}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            // Whether any stat is displayable (in/out/cache/cost/context) — when all are
            // empty the button falls back to a clock icon, avoiding a blank 24px.
            const hasAnyStatValue = Boolean(
              (tokens && (tokens.input > 0 || tokens.output > 0 || tokens.cacheRead > 0 || tokens.cacheWrite > 0))
              || costStr
              || ctxStr
            );

            return (
              <button
                type="button"
                onClick={() => {
                  // Fetch fresh stats once when opening (idle sessions have no live
                  // state; contextUsage would be missing)
                  if (activeTopPanel !== "session") sessionStatsRefresh?.();
                  toggleTopPanel("session");
                }}
               title={tooltip || translate("session.title")}
                 aria-label={translate("session.title")}
                aria-pressed={activeTopPanel === "session"}
                style={{
                  marginLeft: "auto",
                  flexShrink: 0, // not squeezed on narrow screens: otherwise the nowrap content overflows onto the ⋯ button to its right (percent overlapping ⋯); when space is short, clip itemsRow first (its overflowX is hidden)
                  display: "flex", alignItems: "center", gap: isMobile ? 7 : 10,
                  paddingLeft: isMobile ? 6 : 12,
                  // the ⋯ button occupies the right end after it; stats no longer need
                  // a large margin reserved for the file-panel toggle
                  paddingRight: isMobile ? 6 : 12,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  borderLeft: "none", borderRight: "none", borderBottom: "none",
                  borderTop: "none",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  overflow: "hidden", // defensive: clip itself on extremely narrow screens, never overflow onto the adjacent ⋯ button
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {/* Empty-state fallback: when all stats (in/out/cache/cost/context) are empty, show a clock icon
                    as the "session info" entry; otherwise the button is just a blank 24px area. Also shown on
                    the compact tier / mobile when there is no context percentage. */}
                {((isCompact && !ctxStr) || (isMobile && contextUsage?.percent == null) || !hasAnyStatValue) ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                ) : null}
                {/* Mobile tier: battery-percentage-style context indicator (dome icon +
                    color-graded percentage, >70% yellow / >90% red). Only this one
                    compact indicator is shown; full stats (in/out/cost/cache…) are not
                    crammed inline — open the dialog to see them. */}
                {isMobile && contextUsage?.percent != null && (
                  <span style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, color: ctxColor, animation: ctxBreathe }}>
                    <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    <span style={{ fontWeight: 700, fontSize: 11.5 }}>{contextUsage.percent.toFixed(0)}%</span>
                  </span>
                )}
                {/* Compact tier (portrait pad 641–959px): keep only the context usage
                    (the most useful at-a-glance figure), leaving row width to the tag
                    area etc. */}
                {!isMobile && !isCompact && tokens && tokens.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                     {fmt(tokens.input)}
                  </span>
                )}
                 {!isMobile && !isCompact && tokens && tokens.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                     {fmt(tokens.output)}
                  </span>
                )}
                 {!isMobile && !isCompact && tokens && tokens.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                     {fmt(tokens.cacheRead)}
                  </span>
                )}
                {!isMobile && !isCompact && costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {!isMobile && ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor, animation: ctxBreathe }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {/* When space is short / in compact tier show only the context
                        percentage (the most useful at-a-glance figure); wide screens
                        show the full X% / total */}
                    {isCompact ? contextUsage?.percent != null ? contextUsage.percent.toFixed(0) + "%" : "?%" : ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* "⋯" more/customize entry (always rendered, one entry at every size) —
              after the session stats, at the far right */}
          <div style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0, height: "100%" }}>
            <button
              ref={moreBtnRef}
              type="button"
              onClick={handleMoreToggle}
              title={translate("common.more")}
              aria-label={translate("common.more")}
              aria-haspopup="menu"
              aria-expanded={moreOpen || customizeOpen}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: "100%", padding: "0 10px",
                background: moreOpen || customizeOpen ? "var(--bg-selected)" : "none",
                borderLeft: "none", borderBottom: "none",
                borderTop: "none",
                borderRight: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
          </div>
          {/* File-panel toggle pinned at the far right of the top bar (top-right
              corner); the upstream mobile toolbar originally called
              renderMainFileToggle(true), which was lost in the custom-order refactor */}
          {renderMainFileToggle(isMobile)}
          {isMobile && sessionHasBranches && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              compact
              buttonHidden
              containerRef={topBarRef}
              // Panel open/close is controlled by the top-bar button (the branches item
              // inside the ⋯ More toolbar); a merge conflict once turned this into a
              // bare `open` (always true), leaving the panel permanently expanded
              open={activeTopPanel === "branches"}
              onToggle={() => toggleTopPanel("branches")}
              hasSession={showChat}
            />
          )}
          {/* Desktop branch-overflow fallback: when the branch item is squeezed out of
              the top-bar row (into ⋯) there is no inline BranchNavigator; the ⋯ menu's
              Branches item only toggles activeTopPanel — a hidden inline button copy
              carries the rendering (anchored to topBarRef full-width, geometry matching
              the shared dropdown; shows a No branches hint when the tree is empty) */}
          {!isMobile && branchOverflowed && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              compact
              buttonHidden
              containerRef={topBarRef}
              open={activeTopPanel === "branches"}
              onToggle={() => toggleTopPanel("branches")}
              hasSession={showChat}
            />
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div
              data-topbar-dropdown
              style={{
                position: "fixed",
                top: topPanelPos.top,
                left: topPanelPos.left,
                width: topPanelPos.width,
                maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
                overflowY: "auto",
                zIndex: 500,
              }}
            >
              {activeTopPanel === "language" && (
                <div
                  ref={selectionMenuRef}
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        languageBtnRef.current?.focus();
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      style={{
                        display: "flex", alignItems: "center",
                        width: "100%", height: 34, padding: "0 10px",
                        border: "none", borderRadius: 4,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span>{plugin.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "theme" && (
                <div
                  ref={selectionMenuRef}
                  role="menu"
                  aria-label={translate("settings.appearance")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setThemePreference(option.id);
                        themeBtnRef.current?.focus();
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={preference === option.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", minHeight: 34, padding: "0 10px",
                        border: "none", borderRadius: 4,
                        background: preference === option.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(event) => {
                        if (preference !== option.id) event.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(event) => {
                        if (preference !== option.id) event.currentTarget.style.background = "transparent";
                      }}
                    >
                      <ThemeIcon preference={option.id} size={16} />
                      <span>{translate(option.label)}</span>
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "agents" && activeSessionFamily && selectedSession && (
                <AgentSessionPanel
                  rootSession={activeSessionFamily.root}
                  subagents={activeSessionFamily.subagents}
                  selectedSessionId={selectedSession.id}
                  runningSessionIds={runningSessionIds}
                  onSelectSession={handleSelectSession}
                />
              )}
              {activeTopPanel === "system" && (
                <SystemPromptPanel
                  loading={systemInfoLoading}
                  prompt={systemPrompt}
                  translate={translate}
                />
              )}
              {activeTopPanel === "tools" && (
                <ToolDefinitionsPanel
                  loading={systemInfoLoading}
                  tools={systemTools}
                  translate={translate}
                />
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}>
                  {/* Top bar: title + close at the top-right (sticky + panel
                      overflow:clip — the outer dropdown is the actual scroll container,
                      so this row stays visible and clickable while content scrolls;
                      closing equals clicking the session-info button again) */}
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    position: "sticky",
                    top: 0,
                    zIndex: 3,
                    margin: "-12px -16px 0",
                    padding: "8px 16px 7px",
                    background: "var(--bg-panel)",
                    borderBottom: "1px solid var(--border)",
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>{translate("session.infoSection")}</span>
                    <button
                      type="button"
                      title={translate("i18n.close")}
                      aria-label={translate("i18n.close")}
                      onClick={() => setActiveTopPanel(null)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 22,
                        height: 22,
                        padding: 0,
                        color: "var(--text-muted)",
                        background: "var(--bg-panel)",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        cursor: "pointer",
                        flex: "0 0 auto",
                        transition: "color 0.12s, border-color 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--accent)";
                        e.currentTarget.style.borderColor = "var(--accent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-muted)";
                        e.currentTarget.style.borderColor = "var(--border)";
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const ws = selectedSession;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const projectRows = [
                      ...(ws ? [{ label: translate("session.projectDir"), value: ws.projectRoot ?? ws.cwd, copyField: "projectDir" as const }] : []),
                      ...(ws?.branch ? [{ label: translate("session.gitBranch"), value: ws.branch, copyField: "gitBranch" as const }] : []),
                      ...(ws?.isWorktree ? [{ label: translate("session.gitWorktree"), value: ws.cwd, copyField: "gitWorktree" as const }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    // Context row: percent colored by urgency + a 22px tri-state compact
                    // button (same matrix as the large-screen/dialog buttons; i18n reuse,
                    // zero new strings)
                    const ctxUrg = contextUrgency(ctx?.contextWindow ? ctx.percent : null);
                    const compactBusyColor = compactControls?.isCompacting ? "#ef4444" : compactControls?.compactQueued ? "#d97706" : ctxUrg.color;
                    const compactTitle = compactControls?.isCompacting
                      ? translate("chat.stopCompaction")
                      : compactControls?.compactQueued
                        ? translate("chat.cancelCompactQueue")
                        : translate("chat.compactContext");
                    const compactBtn = (compactControls?.compact && ctx?.contextWindow) ? (
                      <button
                        type="button"
                        title={compactTitle}
                        aria-label={compactTitle}
                        onClick={() => {
                          if (compactControls!.isCompacting) compactControls!.abort?.();
                          else if (compactControls!.compactQueued) compactControls!.cancelQueue?.();
                          else void compactControls!.compact?.();
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 22,
                          height: 22,
                          color: compactBusyColor,
                          background: compactControls?.isCompacting ? "rgba(239,68,68,0.08)" : compactControls?.compactQueued ? "rgba(217,119,6,0.1)" : "transparent",
                          border: `1px solid ${compactControls?.isCompacting ? "rgba(239,68,68,0.35)" : compactControls?.compactQueued ? "rgba(217,119,6,0.4)" : "var(--border)"}`,
                          borderRadius: 4,
                          cursor: "pointer",
                          flex: "0 0 auto",
                          animation: !compactControls?.isCompacting && !compactControls?.compactQueued && ctxUrg.level === "critical" ? CTX_BREATHE_CSS : undefined,
                          transition: "color 0.12s, border-color 0.12s, background 0.12s",
                        }}
                      >
                        {compactControls?.isCompacting ? (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>
                        ) : compactControls?.compactQueued ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" /></svg>
                        )}
                      </button>
                    ) : null;
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), (
                         <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                           <span style={{
                             color: ctxUrg.color,
                             fontVariantNumeric: "tabular-nums",
                             animation: ctxUrg.level === "critical" ? CTX_BREATHE_CSS : undefined,
                           }}>{ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"}</span>
                           <span>/ {formatCompact(ctx.contextWindow)}</span>
                           {compactBtn}
                         </span>
                       )]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    // AI-usage rows moved to extensions: auxiliary AI usage (autocomplete/
                    // voice correction etc.) is self-rendered in the AI-input extension's
                    // sessionStats slot item; the overall report entry lives in the
                    // AI-usage extension's item in the same slot.
                    const section = (
                      title: string,
                      sectionRows: ReactNode[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                    const projectInfoSection = projectRows.length > 0 ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {projectRows.map((row) => (
                            <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null;

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20 }}>
                          {sessionInfoSection}
                          {projectInfoSection}
                        </div>
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                  {/* sessionStats extension point: the host only opens the slot; all
                      items are rendered by extensions themselves — the AI-usage
                      extension (report entry button) / the AI-input extension (other
                      auxiliary AI usage stat rows) */}
                  <ProviderUsagePanel currentProviderId={currentModelInfo?.provider ?? null} />
                  <ExtSlot name="sessionStats" extra={{ locale, sessionId: selectedSession?.id ?? null }} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* "⋯" more dropdown: overflow buttons + customize entry (separators stay out
            of the dropdown) */}
        {moreOpen && moreRect && (
          <>
            <div style={{ position: "fixed", top: moreRect.topbarBottom, left: 0, right: 0, bottom: 0, zIndex: 120 }} onClick={() => setMoreOpen(false)} />
            <div
              data-topbar-dropdown
              style={{ position: "fixed", top: moreRect.top, right: moreRect.right, zIndex: 121, minWidth: 196, maxWidth: "min(300px, calc(100vw - 16px))", maxHeight: "calc(100dvh - 8px)", overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", padding: 4 }}
            >
              {overflowMenuNodes.length > 0 && (
                <>
                  {overflowMenuNodes}
                  <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                </>
              )}
              <button
                type="button"
                onClick={openCustomize}
                style={topbarMenuRowStyle}
                onMouseEnter={menuEnter}
                onMouseLeave={menuLeave}
              >
                <span style={topbarMenuIconSlotStyle}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
                </span>
                {translate("topbar.customize")}
              </button>
            </div>
          </>
        )}

        {/* Customize order/hide/separator panel */}
        {customizeOpen && moreRect && (
          <>
            <div style={{ position: "fixed", top: moreRect.topbarBottom, left: 0, right: 0, bottom: 0, zIndex: 120 }} onClick={closePopovers} />
            <div
              style={{ position: "fixed", top: moreRect.top, right: moreRect.right, zIndex: 121, width: 300, maxWidth: "min(340px, calc(100vw - 16px))", maxHeight: "calc(100dvh - 8px)", overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", padding: "6px 0" }}
            >
              <div style={{ padding: "8px 14px 6px", fontSize: 11, fontWeight: 700, color: "var(--text)", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
                {translate("topbar.customize")}
              </div>
              {layout.order.map((item, idx) =>
                item === SEPARATOR ? (
                  <div key={`sep:${idx}`} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 2px 4px" }}>
                    {panelMoveButtons(idx, layout.order.length)}
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 12, minWidth: 0 }}>
                      <div style={{ width: 14, borderTop: "1px solid var(--border)", flexShrink: 0 }} />
                      <span>{translate("topbar.divider")}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSeparator(idx)}
                      title={translate("topbar.removeDivider")}
                      aria-label={translate("topbar.removeDivider")}
                      style={panelSmallBtnStyle}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                  </div>
                ) : (
                  (() => {
                    const hidden = layout.hidden.includes(item);
                    // Extension item labeling: extId:itemId → owning extension (manifest name/icon)
                    const colonIdx = item.indexOf(":");
                    const extId = colonIdx > 0 ? item.slice(0, colonIdx) : null;
                    const extMeta = extId ? extMetas[extId] : null;
                    return (
                      <div key={item} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 2px 4px", opacity: hidden ? 0.55 : 1 }}>
                        {panelMoveButtons(idx, layout.order.length)}
                        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", minWidth: 0 }}>
                          {/* Real icon preview for the item (reuses inline rendering;
                              inert blocks focus/click/screen readers) */}
                          <div inert aria-hidden="true" style={{ width: 30, height: 26, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, pointerEvents: "none" }}>
                            {renderTopbarItem(item, true, false, true)}
                          </div>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{topbarItemLabel(item)}</span>
                          {hidden && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{translate("topbar.hidden")}</span>}
                        </div>
                        {extMeta && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            {/* Extension icons are fully displayed in the extension-manager
                                panel; the host renders only emoji/text markers and does not
                                resolve extension assets (icon.svg etc. are not shown by the host) */}
                            {extMeta.icon && typeof extMeta.icon === "string" && !extMeta.icon.endsWith(".svg") && (
                              <span
                                title={extMeta.name}
                                style={{ fontSize: 11, lineHeight: 1, color: "var(--text-muted)" }}
                              >
                                {extMeta.icon}
                              </span>
                            )}
                            {/* Unified "from an extension" marker */}
                            <span
                              title={translate("topbar.fromExtension")}
                              style={{ display: "inline-flex", alignItems: "center", color: "var(--text-dim)" }}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
                              </svg>
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleHidden(item)}
                          title={hidden ? translate("topbar.show") : translate("topbar.hide")}
                          aria-label={hidden ? translate("topbar.show") : translate("topbar.hide")}
                          aria-pressed={!hidden}
                          style={panelSmallBtnStyle}
                        >
                          {hidden ? (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                          ) : (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                          )}
                        </button>
                      </div>
                    );
                  })()
                ),
              )}
              <div style={{ position: "sticky", bottom: 0, background: "var(--bg)", borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 4 }}>
              <button type="button" onClick={addSeparator} style={panelFooterBtnStyle}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                {translate("topbar.addDivider")}
              </button>
              <button type="button" onClick={resetTopbar} disabled={layout.isDefault} style={panelFooterBtnStyle}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                {translate("topbar.reset")}
              </button>
              </div>
            </div>
          </>
        )}

        {/* The self-exposure no-auth warning moved out with the tunnel-panels
            extension (rendered via <ExtSlot name="banners" />) */}
        <ExtSlot name="banners" />

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <ExtSlot name="pages" extra={{ activeCwd, onSelectSession: handleSelectSession, sessionId: selectedSession?.id ?? null, sessionName: selectedSession?.name ?? null, sessionCwd: selectedSession?.cwd ?? null }} />
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
              onSearchTargetHandled={handleSearchTargetHandled}
              initialScrollPosition={selectedSession ? sessionScrollPositionsRef.current.get(selectedSession.id) ?? null : null}
              onScrollPositionChange={handleSessionScrollPositionChange}
              sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
              newSessionCwd={targetNewSessionCwd}
              newSessionWorkspace={newSessionWorkspace}
              workspaceOptions={newSessionWorkspaceOptions}
              onNewSessionWorkspaceChange={handleNewSessionWorkspaceChange}
              newSessionDraftKey={newSessionDraftKey}
              onAgentEnd={handleAgentEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              onSessionIdCanonicalized={handleSessionIdCanonicalized}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemToolsChange={handleSystemToolsChange}
              onSystemInfoLoaderChange={handleSystemInfoLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onSessionStatsRefresherRegister={handleSessionStatsRefresherRegister}
              onCompactControlsRegister={setCompactControls}
              onContextUsageChange={handleContextUsageChange}
              onDisplayModelChange={setCurrentModelInfo}
              onExportQueue={(resolver) => { exportQueueDataRef.current = resolver; }}
              onOpenFile={handleOpenLinkedFile}
              onOpenSession={handleOpenSession}
              onAskInNewChat={handleAskInNewChat}
              quoteSelectionEnabled={quoteSelectionEnabled}
              initialPrompt={pendingQuotePrompt?.sessionId === selectedSession?.id ? pendingQuotePrompt?.text : undefined}
              onInitialPromptConsumed={() => setPendingQuotePrompt(null)}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          inert={rightPanelFullWidth}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        data-ext-float-dock-zone="right-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelFullWidth ? " right-panel-full-width" : ""}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar — same structure as the main top bar: 36px container
            (divider drawn with inset box-shadow, no content-area cost) */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "none",
          boxShadow: "inset 0 -1px 0 var(--border)",
        }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs}
              activeTabId={activeFileTabId ?? ""}
              revealToken={fileTabRevealToken}
              onSelectTab={guardedSelectFileTab}
              onCloseTab={handleCloseFileTab}
              onDetachTab={handleTabDoubleClick}
              onOpenViewerWindow={(tab) => { openViewerWindowHost(tab.filePath, activeCwd); }}
              onDockFileTab={handleDockFileTab}
            />
          </div>
          {(() => {
            // pathPicker capability (FolderSwitcher from the folder extension); the
            // fallback button opens the CWD when no takeover exists.
            const picker = pathPickerItems.find(hasExtRender);
            if (picker) {
              return (
                <ExtItemBoundary extId={picker.extId} slot="pathPicker" itemId={picker.id}>
                  <picker.render
                    path={activeCwd ?? ""}
                    compact
                    onSelect={(p: string) => handleOpenFolder(p, getFileName(p))}
                  />
                </ExtItemBoundary>
              );
            }
            return (
              <button
                type="button"
                onClick={() => activeCwd && handleOpenFolder(activeCwd, getFileName(activeCwd))}
                title={translate("files.openFolder")}
                aria-label={translate("files.openFolder")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                  background: "var(--bg-selected)", border: "none", borderLeft: "1px solid var(--border)",
                  color: "var(--text)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </button>
            );
          })()}
          <button
            type="button"
            className="file-panel-expand-button"
            onClick={handleRightPanelExpandToggle}
            aria-controls="file-panel"
            aria-pressed={rightPanelFullWidth}
            title={translate(rightPanelFullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
            aria-label={translate(rightPanelFullWidth ? "files.restorePanelWidth" : "files.expandPanel")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={rightPanelFullWidth
                ? "M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"
                : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"} />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setRightPanelOpen(false)}
            aria-controls="file-panel"
            aria-expanded={rightPanelOpen}
            title={translate("files.hidePanel")}
            aria-label={translate("files.hidePanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "var(--bg-selected)", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* [right-panel keep-alive pool] the most recent N non-terminal tabs
            (file/folder/dock) stay mounted, hidden for inactive ones — switching
            rebuilds nothing; after FIFO eviction tabs fall back to reload semantics
            (see the right-dock keep-alive plan doc). Terminals use the always-mounted
            container below. */}
        <div ref={rightPanelContentRef} style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {/* [tab-detach v0.6.0] content dispatch extracted into TabBody (three branches: file/folder/dock),
              structurally identical to the detached window — behavior-equivalent refactor; before changing
              render semantics, use this comment as the regression baseline */}
          {panelTabs
            .filter((t) => t.kind !== "terminal")
            .filter((t) => t.id === activeFileTabId || panelKeepAlive.includes(t.id))
            .map((tab) => (
              <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
                <TabBody tab={tab} host="panel" ctx={tabBodyCtx} />
              </div>
            ))}
          {!activeTabForBody && !terminalTabs.some((tab) => tab.id === activeFileTabId) ? (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--text-dim)", fontSize: 12 }}>
               {fileTabs.length > 0
                 ? translate("files.clickTabToOpen")
                 : <>
                     <span>{translate("files.noneOpen")}</span>
                     <button
                       type="button"
                       onClick={handleOpenCurrentWorkspace}
                       title={translate("files.openCwd")}
                       style={{
                         display: "flex", alignItems: "center", gap: 6,
                         padding: "6px 12px",
                         background: "var(--bg-hover)", border: "1px solid var(--border)",
                         borderRadius: 6, color: "var(--accent)", cursor: "pointer",
                         fontSize: 12, fontWeight: 600,
                       }}
                     >
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                         <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                       </svg>
                       {translate("files.openCwd")}
                     </button>
                   </>}
            </div>
          ) : null}
          {/* Terminal always-mounted hidden container: detached tabs are removed here —
              they render only once in the detached window, preventing double xterm
              instances with double SSE connections (tab-detach §5.3/§5.7) */}
          {terminalTabs.filter((tab) => !detachedTabIds.has(tab.id)).map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanelBridge
                tab={tab}
                active={rightPanelOpen && tab.id === activeFileTabId}
                onClosed={() => handleTerminalClosed(tab)}
                onRestart={() => handleTerminalRestart(tab.id)}
                onCloseError={() => handleTerminalCloseError(tab.id)}
                onOpenShellTab={(openCwd) => handleOpenTerminal(openCwd, true)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
    {/* [floating-dialog extension tab-detach v0.6.0] Detached windows: persistent at
        the React top level (independent of right-panel open state / isMobile — the
        core value of detaching is that the editor is no longer imprisoned by the
        right panel's width). The shell sets the data-ext-float attribute family → the
        floating-dialog extension's scan() takes over drag/resize/maximize/bring-to-
        front/persistence; ✕ goes through the existing handleCloseFileTab guard chain
        (file-editor dirty check); ⇲ = dockBackTab returns it to the right panel and
        activates it. */}
    {detachedWindows.map((w) => (
      <DetachedTabWindow
        key={w.id}
        tab={w}
        initW={detachInitGeom.w}
        initH={detachInitGeom.h}
        dockBackLabel={translate("files.dockBack")}
        closeLabel={translate("i18n.close")}
        onDockBack={() => dockBackTab(w.id)}
        onClose={() => handleCloseFileTab(w.id)}
      >
        <TabBody tab={w} host="window" ctx={tabBodyCtx} />
      </DetachedTabWindow>
    ))}
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        quoteSelectionEnabled={quoteSelectionEnabled}
        onQuoteSelectionChange={handleQuoteSelectionChange}
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    {/* The tunnel-ports dialog moved out with the tunnel-panels extension (rendered
        via <ExtSlot name="dialogs" />) */}
    {/* Restart recovery wizard: sessions that were running when the previous process
        was interrupted + queue (renders null when there is no interruption) */}
    <RestartRecoveryWizard />
    {/* Backend disconnect/restore banner: prompts "please refresh" during a backend
        restart window (SSE broker liveness check; renders null when connected) */}
    <BackendConnBanner />
    <ExtSlot name="dialogs" extra={{ onSelectSession: handleSelectSession, newSessionCwd: effectiveNewSessionCwd }}
      currentSession={selectedSession ? { id: selectedSession.id, cwd: selectedSession.cwd, name: selectedSession.name, firstMessage: selectedSession.firstMessage } : null} />
    {exportDialogOpen && selectedSession && (
      <ExportDialog
        sessionId={selectedSession.id}
        onExportQueue={async () => (exportQueueDataRef.current ? await exportQueueDataRef.current() : null)}
        onClose={() => setExportDialogOpen(false)}
      />
    )}
    {bridgedNameDialog && (
      <SessionNameDialog
        sessionId={bridgedNameDialog.sessionId}
        defaultName={bridgedNameDialog.defaultName}
        onClose={() => setBridgedNameDialog(null)}
        onSaved={(name) => handleBridgedNameSaved(bridgedNameDialog.sessionId, name)}
      />
    )}
    {/* Host-unified toast rendering (pi-web.toast service queue; top-right,
        auto-dismisses) */}
    <HostToastHost />
    </>
    </ExtSlotsProvider>
  );
}

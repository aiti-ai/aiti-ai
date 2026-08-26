"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiUrl, withBasePath } from "@/lib/base-path";

import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { openFileTab, openFolderTab, saveFileViewerState } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ExtSlotsProvider, ExtSlot, useExtSlotItems, useExtMetas } from "./ExtSlots";
import type { ExtRenderProps, ExtUiItemRegistered } from "@/lib/ext-ui-store";
import { getExtUiItems, subscribeExtUi } from "@/lib/ext-ui-store";

/** pathPicker 槽 SSR 稳定空快照（getServerSnapshot 必须返回缓存引用，否则无限循环）。 */
const NO_PATH_PICKER_ITEMS: ExtUiItemRegistered[] = [];
import { registerHostApi } from "@/lib/ext/host-api";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsCompact, useIsMobile, useIsNarrowMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { getDraftApi } from "@/lib/composer/draft-api";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";
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
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
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
import type { FileExplorerHandle } from "./FileExplorer";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { ToolEntry } from "@/lib/tool-presets";
import { getSessionFamily } from "@/lib/session-family";
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
     * aiti-editor（fileViewer 接管扩展）注入的关闭/切换问询接口。可选——未接管/未加载
     * 时不存在，core 一律放行。core 只消费 confirmClose；_restoreSession 是扩展私有
     * 方法（面板重新打开时恢复编辑会话），耦合脆弱，扩展侧应尽早改为公开方法。
     */
    __aitiEditor?: {
      confirmClose?: (p: string, opts?: { isSwitch?: boolean }) => boolean | Promise<boolean>;
      _restoreSession?: () => void;
    };
  }
}

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;
const AGENT_PANEL_WIDTH = 420;

export function AppShell() {
  // 水合完成信号：扩展（如 aiti-draft-keeper）的启动恢复必须等水合结束后落框，
  // 否则 dev 下 hydration 失配重渲染会按服务端 HTML（空框）抹掉恢复的文本。
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
  const { preference, toggleTheme } = useTheme();
  const themeLabelKey =
    preference === "light" ? "theme.light" : preference === "dark" ? "theme.dark" : "theme.auto";
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();
  // 图标按钮宽度统一 36px（与扩展按钮一致）；图标大小也固定 16px（renderTopbarItem 内 iconDim）
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
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
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
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

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
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** ChatWindow 注册的「拉取最新会话统计」回调（含 idle 会话的 contextUsage） */
  const [sessionStatsRefresh, setSessionStatsRefresh] = useState<(() => void) | null>(null);
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

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "system" | "tools" | "session" | "language" | null>(null);
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

  const toggleTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session" | "language",
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
    // idle 会话无 live state 可读（wrapper 被 idle GC），打开面板时主动拉一次
    // get_session_stats，确保 context % 行有值（手机上这是唯一的查看入口）。
    sessionStatsRefresh?.();
    setActiveTopPanel("session");
  }, [isMobile, sessionStatsRefresh]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

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
      if (activeTopPanel === "language" && !isMobile) {
        // 语言按钮可能被收进"⋯"（行内无副本，ref 为 null）→ 改锚"⋯"按钮
        const anchor = languageBtnRef.current ?? moreBtnRef.current;
        if (anchor) {
          const buttonRect = anchor.getBoundingClientRect();
          const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
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
    return () => {
      ro.disconnect();
    };
  }, [activeTopPanel, isMobile]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  // pathPicker 能力（aiti-folder FolderSwitcher）：顶栏「打开文件夹」消费。SSR 稳定空快照。
  const pathPickerItems = useSyncExternalStore(
    subscribeExtUi,
    () => getExtUiItems("pathPicker"),
    () => NO_PATH_PICKER_ITEMS,
  );

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
  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

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
        // 同一 cwd 若已有存活的新建 composer（handleCwdChange 已先发 uuid），不覆盖：
        // 避免 draftId 抖动把一次输入散落多个 new: 槽位（草稿 scatter）。
        const draftId = activeNewSessionDraftKeyRef.current
          && activeNewSessionDraftKeyRef.current.startsWith(`new:`)
          && activeNewSessionDraftKeyRef.current.endsWith(`:${data.cwd}`)
          ? activeNewSessionDraftKeyRef.current.slice(4, activeNewSessionDraftKeyRef.current.length - data.cwd.length - 1)
          : `initial:${requestedCwd}`;
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
  const restoreWorkspaceContext = useCallback((projectKey: string) => {
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
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
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
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = `new:${draftId}:${cwd}`;
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
    if (currentProject !== newProject) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);
      setActiveFileTabId(null);
      setRightPanelOpen(false);
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      restoreWorkspaceContext(newProject);
    }
    router.replace("/", { scroll: false });
  }, [activeCwd, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Advance the project identity to the selected session's project BEFORE the
    // sidebar cwd-sync effect fires. Otherwise handleCwdChange sees a project
    // change (e.g. picking a session from another project in the all-sessions
    // panel / kanban) and tears the just-selected session down — the first click
    // would always fail and only a second click (same project) would stick.
    activeProjectKeyRef.current = workspaceKeyOf(session);
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
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
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [invalidateWorkspaceRestore, router, isMobile, selectedSession]);

  const handleNewSession = useCallback((sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
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
    router.replace("/", { scroll: false });
  }, [invalidateWorkspaceRestore, router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    // Use ?refresh=1 to bypass the 5s TTL cache: a new session's .jsonl may
    // have just been persisted, and a stale cache hit would leave
    // selectedSession as a transient draft (no name, transient=true).
    void fetch(apiUrl("/api/sessions?refresh=1"), { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  const handleOpenSession = useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !data.info) throw new Error(data.error ?? `HTTP ${response.status}`);
      handleSelectSession(data.info);
    } catch (error) {
      console.error("[pi-web] failed to open session:", error instanceof Error ? error.message : error);
    }
  }, [handleSelectSession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

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
    if (!shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
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
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    // Wipe any persisted drafts (all tabs' slots) for the deleted session.
    getDraftApi()?.clearAllDrafts(sessionId);
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      const draftId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [invalidateWorkspaceRestore, selectedSession, router]);

  const handleOpenFile = useCallback((
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
      setRightPanelOpen(true);
      // On mobile the file panel is full-screen; close the drawer so it shows.
      if (isMobile) setSidebarOpen(false);
    }
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  // aiti-editor session-files endpoint (folder tabs reuse the same tombstone
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
    const select = options?.select !== false; // default true
    const tabId = `folder:${folderPath}`;
    setFileTabs((prev) => openFolderTab(prev, { folderName, folderPath, tabId }));
    if (select) {
      setActiveFileTabId(tabId);
      setRightPanelOpen(true);
      // Opening the right panel triggers session restore (tombstone reopen).
      if (typeof (window as unknown as { __aitiEditor?: { _restoreSession?: unknown } }).__aitiEditor?._restoreSession === "function") {
        setTimeout(() => (window as unknown as { __aitiEditor: { _restoreSession: () => void } }).__aitiEditor._restoreSession(), 0);
      }
      if (isMobile) setSidebarOpen(false);
    }
    recordFolder(folderPath, "add");
  }, [isMobile, recordFolder]);

  // ── 通用原语（无策略）：给扩展做 tab 数量/钉住/批量关闭的底层能力 ──
  // getFileTabs：返回当前打开 tab 清单（数组序=打开序）。
  const handleGetFileTabs = useCallback(() =>
    fileTabs.map((t) => ({ id: t.id, filePath: t.filePath, kind: t.kind ?? "file", pinned: t.pinned })),
  [fileTabs]);
  // closeFileTabs：仅从状态移除 + 激活位重排；脏确认/钉住保护等策略由调用方（扩展）负责。
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

  // 扩展宿主公共接口注册（原样能力，不理解为扩展适配；AppShell 零消息/零罗列）
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
      if (!c) return false; // composer 未挂载：调用方不应消费草稿
      c.restoreDraft(draft);
      return true;
    },
  });

  // aiti-devtools 扩展请求打开文件（前端在线查看——文件标签页）：aiti 候选详情点"前端打开"
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
   * 关闭/切换文件前的异步问询：把决定权交给当前查看器（aiti-editor 等接管方）。
   * core 不感知 dirty 等细节——只调用 editor 的 confirmClose(path) → Promise<boolean>，
   * true=放行，false=拦截。无问询能力（未接管）时直接放行。
   */
  const askEditorClose = useCallback(async (filePath: string, isSwitch = false): Promise<boolean> => {
    try {
      const q = window.__aitiEditor?.confirmClose;
      if (typeof q !== "function") return true;
      return (await q(filePath, { isSwitch })) !== false;
    } catch {
      return true; // 问询异常不阻塞关闭
    }
  }, []);

  const guardedSelectFileTab = useCallback(async (tabId: string) => {
    if (tabId === activeFileTabId) return;
    const prevId = activeFileTabId;
    const cur = fileTabs.find((t) => t.id === prevId);
    // 先问后切：editor 放行才真正切换；拦截则留在原 tab（避免乐观切换先卸载
    // viewer、后拒绝时内容已丢）。无问询能力（未接管）时直接放行；文件夹 tab
    // 无编辑状态（FolderViewer 不归 aiti-editor 管），直接切。
    if (cur?.filePath && cur.kind !== "folder") {
      const ok = await askEditorClose(cur.filePath, true);
      if (!ok) return;
    }
    // await 期间 active 可能已被其他交互改掉——只在仍停留原 tab 时才执行切换
    setActiveFileTabId((active) => (active === prevId ? tabId : active));
  }, [activeFileTabId, fileTabs, askEditorClose]);

  const performCloseFileTab = useCallback((tabId: string) => {
    const closing = fileTabs.find((t) => t.id === tabId);
    if (closing?.kind === "folder" && closing.filePath) {
      recordFolder(closing.filePath, "remove");
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs, recordFolder]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // aiti-editor 关闭守卫：异步问询文件查看器是否放行关闭（文件夹 tab 无编辑状态，直接关）
    const closing = fileTabs.find((t) => t.id === tabId);
    if (closing?.kind !== "folder" && closing?.filePath) {
      void askEditorClose(closing.filePath).then((ok) => { if (ok) performCloseFileTab(tabId); });
      return;
    }
    performCloseFileTab(tabId);
  }, [fileTabs, askEditorClose, performCloseFileTab]);

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
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(apiUrl(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`), {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
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
  // 顶栏工具按钮：自定义顺序 + 隐藏 + 间隔 + 溢出"⋯"（统一机制，无屏幕分支）
  // 相关纯逻辑见 lib/topbar-order.ts（持久化 + merge + 间隔归一化）。
  // -------------------------------------------------------------------------
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const itemsRowRef = useRef<HTMLDivElement>(null);
  const measureStripRef = useRef<HTMLDivElement>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [moreRect, setMoreRect] = useState<{ top: number; right: number; topbarBottom: number } | null>(null);
  const [storedOrder, setStoredOrder] = useState<TopbarOrderItem[] | null>(null);
  const [storedHidden, setStoredHidden] = useState<TopbarItemId[]>([]);

  // hydration：localStorage 只能在挂载后读（SSR 安全），初值为默认序
  useEffect(() => {
    setStoredOrder(readTopbarOrder());
    setStoredHidden(readTopbarHidden() ?? []);
  }, []);

  // 扩展槽条目（拍平进顶栏条目列表，id 沿用 ext-ui-store 的 extId:itemId）
  const toolbarExtItems = useExtSlotItems("toolbar");
  const sessionTopbarExtItems = useExtSlotItems("sessionTopbar");
  // 扩展级元数据（manifest name/icon）——面板中标注扩展身份用
  const extMetas = useExtMetas();

  const topbarBuiltinIds = useMemo<TopbarItemId[]>(() => {
    // "services" 已随 service-tunnels 抽离为扩展（扩展条目经 toolbarExtItems 进顶栏）
    const ids: TopbarItemId[] = ["theme", "language"];
    if (showChat) ids.push("history", "export", "title", "branch", "system");
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
      if (seen.has(it.id)) continue; // 同 id 跨槽去重（保留首次出现）
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
      // 会话级 widget（sessionTopbar：标签 ★/chips/+）优先留在顶栏行——设计「聊天顶部栏 tag 区保持可见」；
      // 窄屏时先溢出的改成扩展图标按钮（仍可从 ⋯ 进入）
      ...topbarSessionExtIds,
      ...topbarToolbarExtIds,
      "history", "export", "title", "branch", "system",
    ],
    [topbarToolbarExtIds, topbarSessionExtIds],
  );

  const layout = useMemo(
    () => resolveTopbarLayout(storedOrder, storedHidden, availableIds, topbarDefaultOrder),
    [storedOrder, storedHidden, availableIds, topbarDefaultOrder],
  );

  // 溢出测量：measure strip 离屏渲染全部可见条目（同布局取真实宽度），
  // 行内只渲染 [0..cutoffIndex]。useLayoutEffect 在绘制前完成，无首帧闪烁。
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
      const cutoff = row.clientWidth - 4; // 4px 容差
      const children = Array.from(strip.children) as HTMLElement[];
      let last = -1;
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        if (el.offsetLeft + el.offsetWidth <= cutoff) last = i;
        else break;
      }
      setCutoffIndex((cur) => (cur === last ? cur : last)); // 防死循环
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [visibleKey]);

  const branchIndex = visibleItems.indexOf("branch");
  const branchOverflowed = branchIndex >= 0 && branchIndex > cutoffIndex;
  const overflowItems = visibleItems.slice(cutoffIndex + 1);

  // ⋯ 弹出层定位（以 ⋯ 按钮为锚，右下展开）
  useEffect(() => {
    if (!moreOpen && !customizeOpen) return;
    const btn = moreBtnRef.current;
    if (!btn) return;
    const update = () => {
      const r = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      // 右锚：面板右缘贴近按钮右缘；小屏时钳制保证左缘不出屏
      // （面板最大宽 300 + 8px 边距 → right 上限 vw-8-300）
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

  // 顶栏点击先关弹出层（⋯ 按钮除外，它负责 toggle）：遮罩从顶栏下方开始，
  // 顶栏按钮（含会话统计）保持可点——点击会先关 ⋯/自定义面板再执行自身动作
  // ⚠ React 19：离散事件 capture 阶段的 setState 会【同步 flush】——直接关菜单会在
  // click 的 target/bubble 派发前卸载菜单 DOM，按钮 onClick 随之失效（点击无反应）。
  // 推迟到当前 click 事件处理完（setTimeout 0）后再关，保证按钮自身 onClick 先跑。
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

  // Esc：下拉/面板打开时 capture 拦截关闭（不触发全局 Esc 停 agent）
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

  // ---- 面板操作（即时生效 + 写回 localStorage） ----
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
    // 插到最后一个按钮之前：追加在末尾会被尾部间隔归一化删掉，
    // 插在按钮间才能立即显示并存活（用户随后用 ↑/↓ 移到目标位置）
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

  // ---- 顶栏按钮渲染（行内 / ⋯ 菜单两套外壳） ----
  const topbarMenuRowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8,
    width: "100%", height: 36, padding: "0 14px",
    background: "none",
    // 全部用 longhand，避免与行内按钮的 borderRight/borderTop longhand 混用
    // 触发 React “removing shorthand (border) when conflicting (borderRight)” 告警
    borderLeft: "none", borderRight: "none", borderTop: "none", borderBottom: "none",
    color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 13,
  };
  // ⋯ 菜单图标槽：内建项 icon 包进 36px 槽（右竖线），与扩展按钮（ExtComponent 36px + borderRight）布局完全一致
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
    if (menu) setMoreOpen(false); // ⋯ 内点击先关 ⋯ 再执行
    fn();
  };

  const renderTopbarItem = (id: string, inRow: boolean, forMeasure = false, forPreview = false): React.ReactNode => {
    const menu = !inRow;
    // 图标统一 16px：与扩展按钮（topbarBtnStyle 固定 16px）一致，不再随 isMobile 缩小
    const iconDim = 16;
    if (id === "theme") {
      return (
        <button
          type="button"
          onClick={(e) => {
            if (menu) setMoreOpen(false); // ⋯ 内点击先关 ⋯ 再执行
            const rect = e.currentTarget.getBoundingClientRect();
            toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }}
          title={translate(themeLabelKey)}
          aria-label={translate(themeLabelKey)}
          aria-pressed={preference !== "auto"}
          style={menu
            ? topbarMenuRowStyle
            : { ...topbarRowBtnStyle(), width: TOP_BAR_ICON_BUTTON_SIZE }}
          onMouseEnter={menu ? menuEnter : rowEnter}
          onMouseLeave={menu ? menuLeave : rowLeave}
        >
          <span style={menu ? topbarMenuIconSlotStyle : { display: "contents" }}>
          {preference === "dark" ? (
            <svg width={iconDim} height={iconDim} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : preference === "light" ? (
            <svg width={iconDim} height={iconDim} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width={iconDim} height={iconDim} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          )}
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
      return null; // services 按钮已随 service-tunnels 抽离为扩展（toolbarExtItems 渲染）
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
        // 面板预览：只显示分支图标（BranchNavigator 是完整组件，不宜嵌入小预览）
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
    // 扩展条目：以 React 元素渲染（与 ExtSlot 一致），否则扩展组件内部
    // 的 hooks（ctx.useState 等）会被注入 AppShell 的 hook 序 → 运行时错误
    const toolbarItem = toolbarExtItems.find((it) => it.id === id);
    const sessionItem = sessionTopbarExtItems.find((it) => it.id === id);
    const extItem = toolbarItem ?? sessionItem;
    if (!extItem) return null;
    const ExtComponent = extItem.render as React.ComponentType<ExtRenderProps>;
    const extProps = toolbarItem
      ? { currentSession: null }
      : { currentSession: selectedSession, newSessionCwd: effectiveNewSessionCwd };
    if (menu) {
      // ⋯ 下拉里扩展按钮本身常为纯图标（30px），补一个 meta.label 文字，
      // 与内建条目（图标+文字）对齐，避免"只有图标没文字"；
      // 两槽都补 label（toolbar 图标按钮 / sessionTopbar widget 统一为图标+文字菜单项）
      const extItem2 = toolbarItem ?? sessionItem;
      // noMenuLabel：扩展在 ⋯ 菜单里已自带完整内容（如搜索输入框+按钮），宿主不再补文字 label
      const label = extItem2 && !extItem2.meta?.noMenuLabel
        ? (extItem2.meta?.label ?? extItem2.meta?.title ?? id)
        : null;
      // 整行可点：扩展内部按钮承载动作，点击文字/空白区域委托给它触发（与内建条目整行 button 一致）；
      // 布局与内建条目统一：topbarMenuRowStyle（height 36 + padding 0 14px + gap 8），无中间分割线
      const delegateClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // input/textarea（如 ⋯ 里的搜索输入框）自身承接点击：不委托、不关菜单
        if ((e.target as HTMLElement).closest("button, [role='button'], input, textarea")) return;
        const inner = e.currentTarget.querySelector<HTMLElement>("button, [role='button']");
        if (inner) inner.click();
      };
      return (
        <div
          role="menuitem"
          onClick={delegateClick}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          style={{ ...topbarMenuRowStyle, justifyContent: "flex-start" }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {/* menu 标志：扩展可在菜单场景切换渲染（如 session-manager 搜索框 → 菜单里只显图标+文字） */}
            <ExtComponent {...extProps} menu />
          </div>
          {label && (
            <span style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {label}
            </span>
          )}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <ExtComponent {...extProps} menu={false} />
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
      // 按钮条目：capture 阶段先关 ⋯（内建 onClick 也关，幂等；覆盖扩展按钮内部 onClick）；
      // 会话级 widget（sessionTopbar 槽）是交互组件，内部弹窗依赖组件存活——
      // 点击不关 ⋯，否则 widget 随 ⋯ 卸载、弹窗瞬间消失（"+" 加标签无效）。
      // ⚠ React 19 同步 flush 修复：capture 阶段直接 setMoreOpen 会在 click 的 target 派发前
      // 卸载菜单（按钮 onClick 丢失 → 点击无反应）——defer 到事件处理后关闭。
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

  // ---- 排序/隐藏/间隔面板 ----
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

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        selectedSession={selectedSession}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        onOpenFolder={handleOpenFolder}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        fileExplorerRef={fileExplorerRef}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionsChange={handleSessionsChange}
      />
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
        {/* 扩展点：侧栏底部快捷操作行（与内置 模型/技能/插件 同一排；aiti-extman：扩展管理入口） */}
        <ExtSlot name="sidebarFooter" />
      </div>
    </>
  );

  const renderThemeButton = (mobile: boolean) => (
    <button
      type="button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
      }}
      title={translate(themeLabelKey)}
      aria-label={translate(themeLabelKey)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      data-mobile-toolbar-action={mobile ? "theme" : undefined}
    >
      {preference === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : preference === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )}
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

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
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
          justifyContent: mobileBanner ? "flex-start" : "center",
          gap: 6,
          width: mobileBanner ? "100%" : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : "100%",
          padding: mobileBanner ? "6px 12px" : "0 12px",
          background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "#d97706",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1.35,
          textAlign: "left",
        }}
        data-mobile-trust-banner={mobileBanner ? "true" : undefined}
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
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };


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
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
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
        {mobile && renderThemeButton(true)}
        {mobile && renderLanguageButton(true)}
      </div>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!showChat || (!sessionStats && !contextUsage))) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
    const formatCompact = (value: number) => value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(0)}k`
        : String(value);
    const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

    let contextColor = "var(--text-muted)";
    let desktopContextText: string | null = null;
    let mobileContextText: string | null = null;
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      if (percent !== null && percent > 90) contextColor = "#ef4444";
      else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
      desktopContextText = percent !== null
        ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
        : `? / ${formatCompact(contextUsage.contextWindow)}`;
      mobileContextText = percent !== null ? `${percent.toFixed(0)}%` : null;
    }

    const tooltipParts: string[] = [];
    if (tokens) {
      tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
      tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
      tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
      tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      tooltipParts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    const hasMobileValues = Boolean(
      (tokens && (tokens.input > 0 || tokens.output > 0))
      || costText
      || mobileContextText,
    );

    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        disabled={!showChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        aria-hidden={covered ? true : undefined}
        className={mobile ? "mobile-session-stats" : undefined}
        data-mobile-toolbar-stats={mobile ? "true" : undefined}
        style={{
          marginLeft: mobile ? 0 : "auto",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          flex: mobile ? 1 : undefined,
          minWidth: 0,
          gap: mobile ? 7 : 10,
          paddingLeft: mobile ? 6 : 12,
          paddingRight: mobile ? 6 : 12,
          height: "100%",
          overflow: "hidden",
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {mobile ? (
          <>
            {tokens && tokens.input > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {costText && (
              <span className="mobile-session-stat-cost" style={{ color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
                {costText}
              </span>
            )}
            {mobileContextText && (
              <span style={{ color: contextColor, flexShrink: 0 }}>
                {mobileContextText}
              </span>
            )}
            {!hasMobileValues && showChat && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>
                {translate("session.title")}
              </span>
            )}
          </>
        ) : (
          <>
            {tokens && tokens.input > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {tokens && tokens.cacheRead > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                </svg>
                {formatCompact(tokens.cacheRead)}
              </span>
            )}
            {costText && (
              <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                {costText}
              </span>
            )}
            {desktopContextText && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                </svg>
                {desktopContextText}
              </span>
            )}
          </>
        )}
      </button>
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

  return (
    <ExtSlotsProvider>
    <>
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
      /* 安全区垫层改由 .app-shell-row（globals.css）管理：<641 移动单栏保留 env(safe-area-inset-*)，
         ≥641 多栏布局归零——pad 上系统上报右侧手势区 38px 会把整个三栏垫掉，右侧露出背景空白带
         （实测 pad 竖屏 777px：parPad=[0,38]，主列被挤宧 38px，“缺一块”；横竖切换 inset 变化时大小区不同）。
         多栏下内容自有边距（聊天列 max-w 居中 + 右侧面板自身 right:env()），无需容器级垫层 */
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
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div
          ref={topBarRef}
          style={{
            display: "flex", alignItems: "center", flexShrink: 0,
            // 分割线用 inset box-shadow 画（不占布局空间）：
            // 全局 box-sizing: border-box + 1px border 会吃掉内容区 1px → 容器要写 37px；
            // 改 inset shadow 后容器高度回归基准 36px，内容区即 36px，与按钮/图标槽/扩展完全同构
            borderBottom: "none",
            boxShadow: "inset 0 -1px 0 var(--border)",
            height: "calc(36px + env(safe-area-inset-top))",
            paddingTop: "env(safe-area-inset-top)",
            background: "var(--bg-panel)",
            overflowX: "hidden",
            overflowY: "hidden",
            // 右上角 fixed 的文件面板开关（36px + 间隙）会覆盖右端，预留 padding 防遮挡；
            // 叠加安全区（pad 实测 38px）：按钮 margin-right 避让手势区后实际占 safe-area+36+间隙，
            // padding 只计 36+8——避免 pad 上聊天列右侧再被裁 38px（“右边空一大片”的最后一个来源）
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
          {/* 可排序/隐藏/间隔的工具按钮行：行内只渲染放得下的，离屏 strip 用于测量 */}
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
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
             const tokens = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
             if (tokens) {
               tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
               tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
               tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
               tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => {
                  // 打开时拉一次最新统计（idle 会话无 live state，contextUsage 会缺失）
                  if (activeTopPanel !== "session") sessionStatsRefresh?.();
                  toggleTopPanel("session");
                }}
               title={tooltip || translate("session.title")}
                 aria-label={translate("session.title")}
                aria-pressed={activeTopPanel === "session"}
                style={{
                  marginLeft: "auto",
                  flexShrink: 0, // 窄屏不被压缩：否则 nowrap 内容溢出绘制到右侧 ⋯ 按钮上（百分比与⋯重叠）；空间不足时先裁 itemsRow（其 overflowX hidden）
                  display: "flex", alignItems: "center", gap: isMobile ? 7 : 10,
                  paddingLeft: isMobile ? 6 : 12,
                  // ⋯ 按钮在其后占住右端，统计无需再为文件面板开关预留大边距
                  paddingRight: isMobile ? 6 : 12,
                  height: "100%",
                  background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                  borderLeft: "none", borderRight: "none", borderBottom: "none",
                  borderTop: "none",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  overflow: "hidden", // 防御：极端窄屏下裁自己，永不溢出绘制到相邻 ⋯ 按钮
                  fontVariantNumeric: "tabular-nums",
                  transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
              >
                {(isCompact && !ctxStr) || (isMobile && contextUsage?.percent == null) ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                ) : null}
                {/* 手机档：电池百分比式 context 指示（dome 图标 + 颜色分档的百分比，>70% 黄 / >90% 红）。
                    只放这一个紧凑指示，完整统计（in/out/cost/cache…）不塞行内——点开弹窗查看。 */}
                {isMobile && contextUsage?.percent != null && (
                  <span style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, color: ctxColor }}>
                    <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    <span style={{ fontWeight: 700, fontSize: 11.5 }}>{contextUsage.percent.toFixed(0)}%</span>
                  </span>
                )}
                {/* 紧凑档（pad 竖屏 641–959px）：只保留上下文占用（最有用的一眼信息），把行宽让给 tag 区等 */}
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
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </button>
            );
          })()}
          {/* "⋯" 更多/自定义入口（恒常渲染，任何尺寸同一入口）——位于会话统计之后、最右端 */}
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
          {!isMobile && (
            <>
              {renderThemeButton(false)}
              {renderLanguageButton(false)}
              {renderProjectTrustWarning(false)}
              {renderChatToolbarActions(false)}
              {renderSessionStatsButton(false)}
            </>
          )}
          {!isMobile && renderMainFileToggle(false)}
          {isMobile && sessionHasBranches && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              buttonHidden
              containerRef={topBarRef}
              open
              onToggle={() => toggleTopPanel("branches")}
              hasSession
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
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    // AI 用量行已归扩展：辅助 AI（续写/语音修正等）用量在 aiti-ai-input 的
                    // sessionStats 插槽条目里自渲染；总报表入口在 aiti-ai-usage 同插槽条目。
                    const section = (
                      title: string,
                      sectionRows: string[][],
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
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
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
                  {/* sessionStats 扩展点：宿主只放开插槽，条目全由扩展自行渲染——
                      aiti-ai-usage（报表入口按钮）/ aiti-ai-input（其他辅助 AI 用量统计行） */}
                  <ExtSlot name="sessionStats" extra={{ locale, sessionId: selectedSession?.id ?? null }} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* "⋯" 更多下拉：溢出按钮 + 自定义入口（间隔不进下拉） */}
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

        {/* 自定义顺序/隐藏/间隔面板 */}
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
                    // 扩展条目标注：extId:itemId → 所在扩展（manifest name/icon）
                    const colonIdx = item.indexOf(":");
                    const extId = colonIdx > 0 ? item.slice(0, colonIdx) : null;
                    const extMeta = extId ? extMetas[extId] : null;
                    return (
                      <div key={item} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 2px 4px", opacity: hidden ? 0.55 : 1 }}>
                        {panelMoveButtons(idx, layout.order.length)}
                        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text)", minWidth: 0 }}>
                          {/* 条目真实图标预览（复用行内渲染，inert 防焦点/点击/屏幕阅读器） */}
                          <div inert aria-hidden="true" style={{ width: 30, height: 26, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, pointerEvents: "none" }}>
                            {renderTopbarItem(item, true, false, true)}
                          </div>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{topbarItemLabel(item)}</span>
                          {hidden && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{translate("topbar.hidden")}</span>}
                        </div>
                        {extMeta && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            {/* 扩展图标由扩展管理（aiti-extman）面板完整展示；宿主仅渲染 emoji/文本标记，不解析扩展资产（icon.svg 等路径不在宿主显示） */}
                            {extMeta.icon && typeof extMeta.icon === "string" && !extMeta.icon.endsWith(".svg") && (
                              <span
                                title={extMeta.name}
                                style={{ fontSize: 11, lineHeight: 1, color: "var(--text-muted)" }}
                              >
                                {extMeta.icon}
                              </span>
                            )}
                            {/* 统一"来自扩展"标记 */}
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

        {/* 自暴露无认证告警已随 service-tunnels 抽离为扩展（<ExtSlot name="banners" /> 渲染） */}
        <ExtSlot name="banners" />

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <ExtSlot name="pages" extra={{ activeCwd, onSelectSession: handleSelectSession, sessionId: selectedSession?.id ?? null, sessionName: selectedSession?.name ?? null, sessionCwd: selectedSession?.cwd ?? null }} />
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionDraftKey={newSessionDraftKey}
              onAgentEnd={handleAgentEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemToolsChange={handleSystemToolsChange}
              onSystemInfoLoaderChange={handleSystemInfoLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onSessionStatsRefresherRegister={setSessionStatsRefresh}
              onContextUsageChange={handleContextUsageChange}
              onExportQueue={(resolver) => { exportQueueDataRef.current = resolver; }}
              onOpenFile={handleOpenLinkedFile}
              onOpenSession={handleOpenSession}
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
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar — 与主顶栏同构：容器 36px（分割线用 inset box-shadow，不占内容区） */}
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
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={guardedSelectFileTab}
              onCloseTab={handleCloseFileTab}
            />
          </div>
          {(() => {
            // pathPicker 能力（aiti-folder 扩展的 FolderSwitcher）；无接管则兜底按钮开 CWD。
            const picker = pathPickerItems[0];
            if (picker) {
              return picker.render({
                path: activeCwd ?? "",
                compact: true,
                onSelect: (p: string) => handleOpenFolder(p, getFileName(p)),
              });
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

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {activeFileTab?.kind === "folder" ? (
            <FileViewer
              key={activeFileTab.id}
              kind="folder"
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={selectedSession?.id ?? null}
              gitRefreshKey={explorerRefreshKey}
              watchEnabled={rightPanelOpen}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: selectedSession?.id ?? null },
              )}
              onOpenFolder={(folderPath) => handleOpenFolder(folderPath, getFileName(folderPath))}
              onAtMention={handleAtMention}
            />
          ) : activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialState={activeFileTab.viewerState}
              watchEnabled={rightPanelOpen}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--text-dim)", fontSize: 12 }}>
               {fileTabs.length > 0
                 ? translate("files.clickTabToOpen")
                 : <>
                     <span>{translate("files.noneOpen")}</span>
                     {activeCwd && (
                       <button
                         type="button"
                         onClick={() => handleOpenFolder(activeCwd, getFileName(activeCwd))}
                         title={translate("files.openCwdFolder")}
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
                         {translate("files.openCwdFolder")}
                       </button>
                     )}
                   </>}
            </div>
          )}
        </div>
      </div>
    </div>
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
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
    {/* 服务端口弹窗已随 service-tunnels 抽离为扩展（<ExtSlot name="dialogs" /> 渲染） */}
    <ExtSlot name="dialogs" extra={{ onSelectSession: handleSelectSession }}
      currentSession={selectedSession ? { id: selectedSession.id, cwd: selectedSession.cwd, name: selectedSession.name } : null} />
    {exportDialogOpen && selectedSession && (
      <ExportDialog
        sessionId={selectedSession.id}
        onExportQueue={async () => (exportQueueDataRef.current ? await exportQueueDataRef.current() : null)}
        onClose={() => setExportDialogOpen(false)}
      />
    )}
    </>
    </ExtSlotsProvider>
  );
}

/**
 * session-manager · SidebarDock —— 左栏「项目 / Projects」接管（v2 自包含重写）。
 *
 * 形态（作者 2026-09-06 定稿）：1:1 复刻宿主 SessionSidebar 的项目区——
 *   ▾ 项目 / PROJECTS        ← 折叠头（本组件渲染，persist pi-web:sidebar-projects-collapsed）
 *   CWD picker（原样：当前项目 + activity 蓝点 + 项目下拉/默认目录/自定义路径）
 *   worktree 行（原样：切换/移除/新建）
 *   会话列表（原版树形：SessionTreeItem 行、hover 重命名/删除、行内改名、删除确认、
 *            运行中转圈/未读波点、虚拟化窗口、子会话折叠）
 * 只显示当前选中项目的会话（不做目录分组折叠）；文件区/Header 仍由宿主渲染。
 *
 * 数据链：宿主 SessionSidebar 在 projectsTakeover 分派时经 slot extra 全量透传
 * （sessions/running/unread/draftSession/回调），本组件纯 UI + 本地交互状态；
 * 未落盘新会话的草稿行不绑定选中态（store.pendingDrafts，见 store.ts）；
 * rename/delete/搜索/worktree 走宿主 REST API（HTTP 契约）。
 *
 * 边界：自包含——不 import 宿主源码（vite @/ alias 已废除依赖）；react hooks 经
 * host-shim 委托宿主；全部原版 JSX 手工复制自 52cf228 基线。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiUrl, t, getLocale } from "./host-shim";
import { useStore, refreshSessions, refreshListChannels, refreshWorkspaces, refreshProjectSessions, isProjectSessionsLoaded, noteDraftSession, removePendingDraft, ensureTags, togglePinSession, togglePinProject, type WorkspaceEntry } from "./store";
import { matchesTags, tagPath } from "./helpers";
import {
  SESSION_LIST_ITEM_HEIGHT,
  PROJECTS_COLLAPSED_KEY,
  LAST_CUSTOM_CWD_STORAGE_KEY,
  WORKSPACES_CHANGED_EVENT,
  buildSessionTree,
  displayCwd,
  flattenSessionTree,
  getSessionListIndices,
  loadHiddenWorkspaces,
  loadLastCustomCwd,
  normalizeWorkspaceKey,
  orderProjects,
  pinnedProjectKeys,
  pinnedSessionIds,
  projectSelection,
  saveLastCustomCwd,
  sessionsForProject,
  workspaceKeyOf,
  type ProjectSelection,
  type SessionInfo,
} from "./sidebar/pure";
import { SessionTreeItem } from "./sidebar/session-row";
import { SessionSearchDock } from "./sidebar/session-search";
import { SidebarCwdPicker } from "./sidebar/picker";
import { useWorktree, type WorktreeRuntime } from "./sidebar/use-worktree";
import { useBranchChip } from "./sidebar/branch-chip";
// 薄壳拆分（§5.1）：目录选择器懒 chunk——customPathOpen 门控（LazyMount active=false 不 import）
import { createLazyModule, LazyMount } from "../../../_shared/ext-lazy";
const dirPickerRef = createLazyModule(() => import("./sidebar/directory-picker"));

export interface SidebarDockProps {
  cwd?: string;
  homeDir?: string;
  sessions?: SessionInfo[];
  loading?: boolean;
  error?: string | null;
  sessionListVersion?: number | null;
  runningSessionIds?: Set<string>;
  unreadSessionIds?: Set<string>;
  selectedSessionId?: string | null;
  selectedSession?: SessionInfo | null;
  draftSession?: SessionInfo | null;
  explorerOpen?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  onCwdChange?: (cwd: string) => void;
  onSelectSession?: (s: SessionInfo, entryId?: string, blockIndex?: number) => void;
  onNewSession?: () => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onRefresh?: () => void;
  /** catalog 回灌：store.sessions 变化时上报宿主（SessionSidebar → AppShell
   *  sessionCatalog，接管态宿主已停全量拉——统一后由本组件供数）。 */
  onSessionsChange?: (sessions: SessionInfo[]) => void;
  /** 原版 loadSessions 触发时机的等价映射（AppShell 会话切换/新建后 bump）。 */
  refreshKey?: number;
  /** running 回灌：store.running（refreshSessions runRes 快照 + 扩展 SSE 变化帧）
   *  上报宿主（原 loadSessions 快照已下线，unread 推导/蓝点/运行下拉依赖）。 */
  onRunningSessionIds?: (ids: Set<string>) => void;
  /** worktree 运行时（dock 层 useWorktree 上提注入；分支 chip 方案 §2——独立行删除后
   *  SidebarList 只消费 projectKey 推导，UI 在共享 BranchPanel） */
  worktree?: WorktreeRuntime;
  /** 分支 chip 徽标（picker 行右端 rightSlot 挂载；git-ops 方案 2026-09-17 版式修订） */
  chipBadge?: unknown;
  /** 绑定「打开项目下拉」的回调（折叠头活动蓝点点击用——蓝点只报信，看哪里有事靠下拉里的 ● 徽标） */
  bindPickerOpener?: (fn: () => void) => void;
}

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

/** SidebarList —— 项目区内容本体（v4 拆分）：CWD picker + worktree + 搜索 + 会话列表。
 *  统一 dock 方案 §3.3：sidebarContent 接管态由 SidebarContentDock 以 DockBody 常驻区块
 *  形态渲染（折叠头行归 DockBody）；旧 sidebarProjects 回退路径仍经 SidebarDock（折叠头壳）。 */
export function SidebarList(props: SidebarDockProps) {
  const store = useStore();
  const {
    cwd: selectedCwdProp,
    homeDir = "",
    // sessions 数据源（统一大调用）：接管态宿主已停全量拉，列表/家族树统一走
    // 本扩展聚合 /sessions（ETag/304+节流；含外部 agent 会话超集）——
    // props.sessions 为旧通道字段仅回退态语义，dock 不再消费。
    loading: _loadingFromHost = false,
    error = null,
    refreshKey = 0,
    sessionListVersion = null,
    runningSessionIds: _runningFromHost = new Set<string>(),
    unreadSessionIds = new Set<string>(),
    selectedSessionId = null,
    selectedSession = null,
    draftSession: draftSessionProp = null,
    explorerOpen = false,
    searchOpen = false,
    searchQuery = "",
    onSearchQueryChange,
    onCwdChange,
    onSelectSession,
    onNewSession,
    onRenamed,
    onSessionDeleted,
    onRefresh,
    onSessionsChange,
    worktree: worktreeRt,
    chipBadge,
    bindPickerOpener,
  } = props;

  const sessions = (store.projectSessions ?? []) as SessionInfo[];
  // [通道拆分] 全量通道仍供宿主 catalog（家族树）/草稿判定/兜底 projectFor；
  // 侧栏列表/项目 picker 改由 scoped + workspaces 两条快通道供数（见下方各 useMemo）。
  const allSessions = (store.sessions ?? []) as SessionInfo[];
  const workspaceEntries = (store.workspaces ?? []) as WorkspaceEntry[];
  // loading 由本组件持有（定义见 selectedProject 之后；TDZ 约束）：
  // 当前项目 key 的 scoped 列表落地前视为加载中（切换项目也回 loading）。
  useEffect(() => {
    let alive = true;
    // 快通道：项目列表（轻量聚合）先落地，不阻塞侧栏。
    void refreshWorkspaces(unreadSessionIds);
    // 全量通道延后拉：宿主 catalog（家族树）/All Sessions/看板依赖它，不阻塞首屏。
    const fullTimer = setTimeout(() => { if (alive) void refreshSessions(); }, 800);
    // 置顶判断依赖 tagData（固定 tag「📌 置顶」反查）：挂载即加载，未就绪时 pinnedIds 为空集不阻塞列表
    void ensureTags();
    return () => { alive = false; clearTimeout(fullTimer); };
  }, []);
  // running 快照与变化检测归扩展（负总责）：refreshSessions 的 runRes 并行拉
  // /api/agent/running（初始快照）+ 本扩展 SSE 集合变化帧（运行开始/结束）。
  // props.runningSessionIds 为宿主 SSE 旧通道，刷新后无初始帧会恒空——弃用。
  const runningSessionIds = store.running as Set<string>;
  const storeRevRef = useRef(0);
  const lastSessionsRef = useRef(sessions);
  if (lastSessionsRef.current !== sessions) {
    lastSessionsRef.current = sessions;
    storeRevRef.current += 1;
  }
  const storeRev = storeRevRef.current;


  const locale = getLocale();

  // ── CWD picker 状态（宿主同构）──
  const [selectedCwd, setSelectedCwd] = useState<string | null>(selectedCwdProp ?? null);
  useEffect(() => { setSelectedCwd(selectedCwdProp ?? null); }, [selectedCwdProp]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<ReadonlySet<string>>(() => loadHiddenWorkspaces());
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ProjectSelection | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // 上提「打开项目下拉」给折叠头蓝点（bindPickerOpener 回调-ref：父层 identity 变化不重绑）
  const openPickerDropdown = useCallback(() => setDropdownOpen(true), []);
  const binderRef = useRef(bindPickerOpener);
  binderRef.current = bindPickerOpener;
  useEffect(() => { binderRef.current?.(() => openPickerDropdown()); }, [openPickerDropdown]);

  // ── worktree 状态已上提（use-worktree hook，dock 层注入 props.worktree）──

  // ── 列表虚拟化 + 树折叠状态 ──
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [listViewportH, setListViewportH] = useState(0);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const toggleSessionCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const listScrollRafRef = useRef<number | null>(null);
  const handleListScroll = useCallback((e: { currentTarget: { scrollTop: number } }) => {
    const top = e.currentTarget.scrollTop;
    if (listScrollRafRef.current != null) return;
    listScrollRafRef.current = requestAnimationFrame(() => {
      listScrollRafRef.current = null;
      setListScrollTop(top);
    });
  }, []);
  const searchActive = searchOpen && Boolean(searchQuery.trim());

  // ── 高级搜索（All Sessions 过滤条件进 sider dock：agent 来源 + tag；
//    文档条件属后续方案，见 docs/todo-sm-sidebar-search-doc-condition.md）──
  const [advOpen, setAdvOpen] = useState(() => {
    try { return localStorage.getItem("sm.dock.searchAdv") === "1"; } catch { return false; }
  });
  const toggleAdv = useCallback(() => {
    setAdvOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem("sm.dock.searchAdv", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // 空集 = 不过滤（与 All Sessions 面板「默认只选 pi」不同：dock 搜索是即时动作视图，默认全量）
  const [dockAgents, setDockAgents] = useState<Set<string>>(() => new Set());
  const [dockTagIds, setDockTagIds] = useState<string[]>([]);
  useEffect(() => { if (advOpen) void ensureTags(); }, [advOpen]);
  const toggleDockAgent = useCallback((agent: string) => {
    setDockAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent); else next.add(agent);
      return next;
    });
  }, []);
  const toggleDockTag = useCallback((tagId: string) => {
    setDockTagIds((prev) => prev.includes(tagId) ? prev.filter((x) => x !== tagId) : [...prev, tagId]);
  }, []);
  // agent 选项 = 列表会话里实际出现的来源（pi 恒在首位）；tag 选项 = 有会话在用的标签
  const agentOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const a = s.agent || "pi";
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const list = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    list.sort((x, y) => (x[0] === "pi" ? -1 : y[0] === "pi" ? 1 : 0));
    return list;
  }, [sessions]);
  const tagOptions = useMemo(() => {
    const data = store.tagData;
    if (!data?.tags?.length) return [];
    const used = new Set<string>();
    for (const ids of Object.values(data.sessionTags ?? {})) for (const id of ids as string[]) used.add(id);
    return data.tags.filter((n: any) => used.has(n.id));
  }, [store.tagData]);
  const extraFilter = useMemo(() => {
    if (!dockAgents.size && !dockTagIds.length) return null;
    return (s: SessionInfo) => (!dockAgents.size || dockAgents.has(s.agent || "pi"))
      && (!dockTagIds.length || matchesTags(s.id, store.tagData, dockTagIds));
  }, [dockAgents, dockTagIds, store.tagData]);
  // sm FTS 外部命中 → 会话对象回联（聚合 /sessions 列表含外部源行，id 直查）；
  // 只回联 live 列表有的行（归档/虚拟行开不了会话，跳过）。
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const resolveExternal = useCallback((hit: { sessionId: string }) => sessionsById.get(hit.sessionId) ?? null, [sessionsById]);
  // ── 文档条件（todo-sm-sidebar-search-doc-condition §3/§4-P1）：勾选文档 → 反查触达会话 ──
  const [dockDoc, setDockDoc] = useState<{ docId: number; title: string; relpath: string } | null>(null);
  const [docPickOpen, setDocPickOpen] = useState(false);
  const [docListState, setDocListState] = useState<{ docs: Array<{ id: number; title: string; relpath: string }>; available: boolean } | null>(null);
  const [docFilter, setDocFilter] = useState("");
  useEffect(() => {
    if (!docPickOpen) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(apiUrl("/api/extensions/session-manager/doc-list?limit=200"), { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json() as { available?: boolean; docs?: Array<{ id: number; title: string; relpath: string }> };
        if (!controller.signal.aborted) setDocListState({ docs: d.docs ?? [], available: d.available !== false });
      } catch {
        if (!controller.signal.aborted) setDocListState({ docs: [], available: false });
      }
    })();
    return () => controller.abort();
  }, [docPickOpen]);
  const shownDocs = useMemo(() => {
    const docs = docListState?.docs ?? [];
    const f = docFilter.trim().toLowerCase();
    return f ? docs.filter((d) => (d.title + " " + d.relpath).toLowerCase().includes(f)) : docs;
  }, [docListState, docFilter]);

  useLayoutEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setListViewportH(entry.contentRect.height);
    });
    ro.observe(el);
    // 初始尺寸/滚动位读取延后到 rAF：useLayoutEffect 时机在 DOM 变更后、布局前，
    // 此刻同步读 clientHeight 会强制整页同步布局（实测页面加载期 116ms 强制重排，
    // ForcedReflow 榜首）。rAF 回调在布局完成后执行，读取不触发新重排；值语义不变。
    const raf = requestAnimationFrame(() => {
      setListViewportH(el.clientHeight);
      setListScrollTop(el.scrollTop);
    });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [searchActive]);

  // 隐藏工作区列表变化（session-manager 管理弹窗写；同页事件 + 跨 tab storage）
  useEffect(() => {
    const syncHidden = () => setHiddenWorkspaces(loadHiddenWorkspaces());
    window.addEventListener(WORKSPACES_CHANGED_EVENT, syncHidden);
    window.addEventListener("storage", syncHidden);
    return () => {
      window.removeEventListener(WORKSPACES_CHANGED_EVENT, syncHidden);
      window.removeEventListener("storage", syncHidden);
    };
  }, []);

  // ── 项目推导（[通道拆分] recentProjects 来自轻量 workspaces 聚合，不依赖 1MB 全量）──
  const recentProjects = useMemo(
    () => workspaceEntries.map((w) => ({ key: w.key, root: w.root })),
    [workspaceEntries],
  );

  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    const ws = worktreeRt?.state ?? null;
    if (ws && ws.forCwd === cwd) {
      return projectSelection(ws.projectRoot, ws.projectKey);
    }
    if (ws?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(ws.projectRoot, ws.projectKey);
    }
    // workspaces 精确匹配（快通道）：root 直配或 key 归一匹配
    const wsMatch = workspaceEntries.find((w) => w.root === cwd || w.key === normalizeWorkspaceKey(cwd));
    if (wsMatch) return projectSelection(wsMatch.root, wsMatch.key);
    // 全量兜底（延后通道；保持原回退语义）
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, normalizeWorkspaceKey(cwd));
  }, [validatedProject, worktreeRt, workspaceEntries, allSessions]);

  const selectedProject = projectFor(selectedCwd);
  // loading 定义（TDZ 安全：selectedProject 已声明）：当前项目 scoped 列表未落地 = 加载中。
  // [空环境兜底 2026-11-04] selectedProject 为 null（无 cwd 上下文——全新部署零会话/零项目，
  // 宿主未下发 cwd）时**不进 Loading**：isProjectSessionsLoaded("") 恒 false 会让 Loading
  // 永驻（空数据环境下 scoped 拉取永不触发）。此时直接渲染空态（SessionTree emptyLabel
  // "No recent sessions" + 选项目引导），用户绑定项目后 key 非空才走真实加载期。
  const loading = Boolean(selectedProject) && !isProjectSessionsLoaded(selectedProject?.key ?? "");
  // 未落盘草稿行（不绑定选中态）：选中会话不在任何列表 → 记入 store.pendingDrafts
  //（切到其他会话仍保留显示，落盘后被 /sessions 列出 → reconcile 自动转正）。
  // 注意排除 archived 桶：归档残留选中态（宿主 onSessionDeleted 收尾前）不能误记成草稿。
  useEffect(() => {
    if (!selectedSession?.id || !selectedSession.cwd) return;
    if ((store.sessions ?? []).some((x) => x.id === selectedSession.id)) return;
    if ((store.archived ?? []).some((x) => x.id === selectedSession.id)) return;
    noteDraftSession(selectedSession);
  }, [selectedSession, store.sessions, store.archived]);
  // 选中 id 被宿主规范化迁移（new-*/别名 → 真实复合 id，同会话）：旧 id 的草稿行
  // 已被列表行取代，移除防双行（普通切换会话不触发此事件，草稿保留语义不变）。
  useEffect(() => {
    const onCanonicalized = (e: Event) => {
      const prev = (e as CustomEvent<{ previousId?: string }>).detail?.previousId;
      if (prev) removePendingDraft(prev);
    };
    window.addEventListener("pi-web:session-id-canonicalized", onCanonicalized);
    return () => window.removeEventListener("pi-web:session-id-canonicalized", onCanonicalized);
  }, []);
  // 切会话 → 刷新列表：新会话已落盘时尽早把行转正/从 pending 淡出。
  // pending 非空时升级为 refresh=1：绕过服务端 5s 扫描缓存（落盘已发生但缓存
  // 未过期 → 普通刷新拿不到新行 → 草稿态残留不转正）。合流节流兜底。
  useEffect(() => {
    const refresh = (store.pendingDrafts?.length ?? 0) > 0;
    void refreshSessions({ refresh });
    const key = selectedProject?.key;
    if (key) void refreshProjectSessions(key, { refresh });
  }, [selectedSessionId]);
  // 未落盘草稿行渲染源（按当前项目过滤；本项目 selectedProject 为空=显示全部）
  const pendingDraftsForProject = useMemo(() => {
    const drafts = (store.pendingDrafts ?? []).map((p) => p.session);
    return selectedProject
      ? drafts.filter((s) => projectFor(s.cwd)?.key === selectedProject.key)
      : drafts;
  }, [store.pendingDrafts, selectedProject, projectFor]);

  // catalog 回灌：接管态宿主 SessionSidebar 的 allSessions 冻结，AppShell
  // sessionCatalog（家族树）由本组件经 onSessionsChange 持续供数。
  // [通道拆分] 仍喂**全量** allSessions（家族树需要完整父子链）；scoped 只服务侧栏列表。
  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);
  // running 回灌：宿主 runningSessionIds 的更新源（原 loadSessions 快照已下线）；
  // 宿主 unread 推导/picker 蓝点/AppShell 运行下拉依赖它。
  const onRunningSessionIds = props.onRunningSessionIds;
  useEffect(() => {
    onRunningSessionIds?.(runningSessionIds);
  }, [runningSessionIds, onRunningSessionIds]);
  // [通道拆分] scoped 列表自拉：selectedProject.key 变化（初始选定/切换项目）→ 拉该项目会话。
  // 项目列表（workspaces）在挂载 effect 拉过 + unread 变化时重拉（见下）。
  useEffect(() => {
    const key = selectedProject?.key;
    if (key) void refreshProjectSessions(key);
  }, [selectedProject?.key]);
  // unread 变化 → 项目红点计数重拉（workspaces 带 unread= 参数回算 unreadCount）
  useEffect(() => {
    void refreshWorkspaces(unreadSessionIds);
  }, [unreadSessionIds]);
  // 原版 loadSessions 触发时机的等价映射：AppShell refreshKey（会话切换/新建/
  // 恢复后 bump）→ store 刷新。事件驱动非轮询；节流合流兜底。
  // 原版 loadSessions 触发时机的等价映射：AppShell refreshKey（会话切换/新建/恢复后
  // bump；agent 每回合结束 handleAgentEnd 也 bump——回复完成即 .jsonl 落盘）→ store
  // 刷新。pending 非空时升级 refresh=1（绕过服务端 5s 扫描缓存，草稿态即时转正）。
  useEffect(() => {
    const refresh = (store.pendingDrafts?.length ?? 0) > 0;
    void refreshSessions({ refresh });
    const key = selectedProject?.key;
    if (key) void refreshProjectSessions(key, { refresh });
    void refreshWorkspaces(unreadSessionIds);
  }, [refreshKey, selectedProject?.key]);
  void draftSessionProp;
  const isCurrentProject = (root: string) => selectedProject?.root === root;
  // 项目钉住（favoriteIds 的 "ws:" 项；方案 docs/session-manager-project-pin-order-plan.md）：
  // 钉段按钉内顺序在前，其余保持活跃降序；过滤只缩集合不改序（钉=常用）。
  const pinnedProjKeys = useMemo(() => pinnedProjectKeys(store.tagData), [store.tagData]);
  const visibleProjects = orderProjects(projectFilter.trim()
    ? recentProjects.filter((project) =>
        (isCurrentProject(project.root) || !hiddenWorkspaces.has(project.root))
        && project.root.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects.filter((project) => isCurrentProject(project.root) || !hiddenWorkspaces.has(project.root)), pinnedProjKeys);

  const projectActivity = useMemo(() => {
    // [通道拆分] 角标计数由 workspaces 聚合提供（runningCount/unreadCount），不依赖全量行。
    const m = new Map<string, { running: number; unread: number }>();
    for (const w of workspaceEntries) {
      m.set(w.key, { running: w.runningCount ?? 0, unread: w.unreadCount ?? 0 });
    }
    return m;
  }, [workspaceEntries]);

  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  // 只显示当前项目的会话（不做目录分组折叠）
  const filteredSessions = selectedProject
    ? sessionsForProject(sessions, selectedProject.key)
    : sessions;
  // 未落盘草稿行钉在列表顶部（已转正的剔除——reconcile 正常移除，此处防御去重）
  const inLiveIds = new Set(filteredSessions.map((s) => s.id));
  const draftsForTree = pendingDraftsForProject.filter((s) => !inLiveIds.has(s.id));
  const draftIds = new Set(draftsForTree.map((s) => s.id));
  const sessionsForTree = [...draftsForTree, ...filteredSessions];
  // 置顶集合（固定 tag 承载，服务端 tags 持久化多设备共享；tagData 未就绪视为空集）
  const pinnedIds = useMemo(() => pinnedSessionIds(store.tagData), [store.tagData]);
  const sessionTree = useMemo(() => buildSessionTree(sessionsForTree, pinnedIds), [sessionsForTree, pinnedIds]);

  // ── worktree 推导已上提（use-worktree hook；独立行删除，UI 在共享 BranchPanel）──

  // ── handlers（宿主同构）──
  const handleSelectProject = useCallback((root: string) => {
    setSelectedCwd(root);
    setProjectFilter("");
    setCustomPathOpen(false);
    setCustomPathError(null);
    setDropdownOpen(false);
    onCwdChange?.(root);
  }, [onCwdChange]);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;
    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch(apiUrl("/api/cwd/validate"), {
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
        key: normalizeWorkspaceKey(data.projectKey),
      });
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      onCwdChange?.(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, onCwdChange]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/default-cwd"), { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        onCwdChange?.(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [onCwdChange]);

  // 下拉外点关闭（宿主同款）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 行点击：cwd 联动 + 上报宿主（宿主 handleSelectSessionFromList 已含，直接透传）
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    onSelectSession?.(s, entryId, blockIndex);
  }, [onSelectSession]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    onNewSession?.();
  }, [selectedCwd, onNewSession]);

  // ── 渲染（内容本体；折叠头行归调用方的 DockBody/SidebarDock 壳）──
  return (
    <>
      {customPathOpen && (
            <LazyMount
              active={customPathOpen}
              load={dirPickerRef}
              pick="DirectoryPicker"
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

          {/* CWD picker + worktree（原样；picker/worktree 固定高度，不随列表滚动；底部 border 与原版 Header 分隔线同款）。
              分支 chip（2026-09-17 版式修订）：picker 行右端右对齐；折叠头只留活动蓝点 */}
          <div style={{ flexShrink: 0, padding: "0 10px 10px", borderBottom: "1px solid var(--border)" }}>
            <SidebarCwdPicker
              dropdownRef={dropdownRef}
              dropdownOpen={dropdownOpen}
              setDropdownOpen={setDropdownOpen}
              projectFilter={projectFilter}
              setProjectFilter={setProjectFilter}
              selectedCwd={selectedCwd}
              homeDir={homeDir}
              selectedProject={selectedProject}
              recentProjects={recentProjects}
              visibleProjects={visibleProjects}
              projectActivity={projectActivity}
              customPathOpen={customPathOpen}
              customPathValue={customPathValue}
              onSelectProject={handleSelectProject}
              onDefaultCwd={() => void handleDefaultCwd()}
              onCustomPathClick={handleCustomPathClick}
              hiddenWorkspaces={hiddenWorkspaces}
              pinnedKeys={pinnedProjKeys}
              onTogglePinProject={togglePinProject}
              rightSlot={chipBadge}
            />

            {searchOpen && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
                <input
                  id="sm-session-search-input"
                  type="search"
                  autoFocus
                  value={searchQuery}
                  maxLength={200}
                  aria-label={t("sidebar.searchSessions")}
                  placeholder={t("sidebar.searchSessions")}
                  onChange={(event) => onSearchQueryChange?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      onSearchQueryChange?.("");
                    }
                  }}
                  className="block h-[29px] w-full min-w-0 flex-1 rounded-[7px] border border-border bg-bg px-[10px] text-xs text-text focus:outline-2 focus:outline-accent"
                />
                <button
                  type="button"
                  onClick={toggleAdv}
                  title={t("sm.dockAdvTitle")}
                  aria-pressed={advOpen}
                  style={{
                    flexShrink: 0, height: 29, padding: "0 8px", borderRadius: 7, cursor: "pointer",
                    fontSize: 11, border: "1px solid " + (advOpen ? "var(--accent, #6366f1)" : "var(--border)"),
                    color: advOpen ? "var(--accent, #6366f1)" : "var(--text-muted)",
                    background: advOpen ? "color-mix(in srgb, var(--accent, #6366f1) 12%, transparent)" : "transparent",
                  }}
                >{t("sm.dockAdv")}</button>
              </div>
            )}

            {searchOpen && advOpen && (
              <div style={{ marginTop: 6, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 11 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "flex-start" }}>
                  <span style={{ flexShrink: 0, lineHeight: "18px", color: "var(--text-muted)", fontSize: 10 }}>{t("sm.dockAdvAgents")}</span>
                  {agentOptions.map(([agent, count]) => {
                    const on = dockAgents.has(agent);
                    return (
                      <button
                        key={agent}
                        type="button"
                        onClick={() => toggleDockAgent(agent)}
                        title={`${agent} (${count})`}
                        style={{
                          padding: "0 7px", lineHeight: "18px", borderRadius: 9, cursor: "pointer", fontSize: 10,
                          border: "1px solid " + (on ? "var(--accent, #6366f1)" : "var(--border)"),
                          color: on ? "var(--accent, #6366f1)" : "var(--text-muted)",
                          background: on ? "color-mix(in srgb, var(--accent, #6366f1) 12%, transparent)" : "transparent",
                        }}
                      >{agent}</button>
                    );
                  })}
                  {dockAgents.size > 0 && (
                    <button type="button" onClick={() => setDockAgents(new Set())}
                      style={{ padding: "0 4px", lineHeight: "18px", border: "none", background: "none", cursor: "pointer", fontSize: 10, color: "var(--text-dim)" }}
                    >✕</button>
                  )}
                </div>
                {tagOptions.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "flex-start", marginTop: 5 }}>
                    <span style={{ flexShrink: 0, lineHeight: "18px", color: "var(--text-muted)", fontSize: 10 }}>{t("sm.dockAdvTags")}</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 72, overflowY: "auto", minWidth: 0 }}>
                      {tagOptions.map((n: any) => {
                        const on = dockTagIds.includes(n.id);
                        return (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => toggleDockTag(n.id)}
                            title={tagPath(n.id, store.tagData)}
                            style={{
                              padding: "0 7px", lineHeight: "18px", borderRadius: 9, cursor: "pointer", fontSize: 10,
                              maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              border: "1px solid " + (on ? (n.color || "var(--accent, #6366f1)") : "var(--border)"),
                              color: on ? (n.color || "var(--accent, #6366f1)") : "var(--text-muted)",
                              background: on ? "color-mix(in srgb, " + (n.color || "var(--accent, #6366f1)") + " 12%, transparent)" : "transparent",
                            }}
                          >{n.name}</button>
                        );
                      })}
                    </div>
                    {dockTagIds.length > 0 && (
                      <button type="button" onClick={() => setDockTagIds([])}
                        style={{ padding: "0 4px", lineHeight: "18px", border: "none", background: "none", cursor: "pointer", fontSize: 10, color: "var(--text-dim)" }}
                      >✕</button>
                    )}
                  </div>
                )}
                {/* 📄 文档条件（P1）：勾选文档 → 反查触达 session（文本匹配文档内容属 P2） */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "flex-start", marginTop: 5 }}>
                  <span style={{ flexShrink: 0, lineHeight: "18px", color: "var(--text-muted)", fontSize: 10 }}>{t("sm.dockAdvDoc")}</span>
                  {dockDoc ? (
                    <button
                      type="button"
                      onClick={() => setDocPickOpen((v) => !v)}
                      title={dockDoc.relpath}
                      style={{
                        padding: "0 7px", lineHeight: "18px", borderRadius: 9, cursor: "pointer", fontSize: 10,
                        maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        border: "1px solid var(--accent, #6366f1)", color: "var(--accent, #6366f1)",
                        background: "color-mix(in srgb, var(--accent, #6366f1) 12%, transparent)",
                      }}
                    >📄 {dockDoc.title}</button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDocPickOpen((v) => !v)}
                      style={{
                        padding: "0 7px", lineHeight: "18px", borderRadius: 9, cursor: "pointer", fontSize: 10,
                        border: "1px solid " + (docPickOpen ? "var(--accent, #6366f1)" : "var(--border)"),
                        color: docPickOpen ? "var(--accent, #6366f1)" : "var(--text-muted)", background: "transparent",
                      }}
                    >{t("sm.dockAdvDocPick")}</button>
                  )}
                  {dockDoc && (
                    <button type="button" onClick={() => { setDockDoc(null); setDocPickOpen(false); }}
                      style={{ padding: "0 4px", lineHeight: "18px", border: "none", background: "none", cursor: "pointer", fontSize: 10, color: "var(--text-dim)" }}
                    >✕</button>
                  )}
                </div>
                {docPickOpen && (
                  <div style={{ marginTop: 5, border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
                    <input
                      value={docFilter}
                      onChange={(e) => setDocFilter(e.target.value)}
                      placeholder={t("sm.dockAdvDocPick")}
                      className="block h-[24px] w-full rounded-[5px] border border-border bg-bg px-2 text-[11px] text-text focus:outline-1 focus:outline-accent"
                    />
                    <div style={{ maxHeight: 160, overflowY: "auto", marginTop: 4 }}>
                      {shownDocs.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => { setDockDoc({ docId: d.id, title: d.title, relpath: d.relpath }); setDocPickOpen(false); setDocFilter(""); }}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "4px 6px", border: "none", background: "none", cursor: "pointer", borderRadius: 5 }}
                        >
                          <span className="block truncate text-xs text-text">{d.title}</span>
                          <span className="block truncate text-[10px] text-text-dim">{d.relpath}</span>
                        </button>
                      ))}
                      {docListState && shownDocs.length === 0 && (
                        <div style={{ padding: "6px", fontSize: 10, color: "var(--text-dim)" }}>{t("sm.dockAdvDocEmpty")}</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 会话列表（原版树形 + 虚拟化窗口） */}
          <SessionSearchDock open={searchOpen} query={searchQuery} refreshKey={storeRev} selectedSessionId={selectedSessionId} onSelectSession={handleSelectSessionFromList} extraFilter={extraFilter} resolveExternal={resolveExternal} docCondition={advOpen ? dockDoc : null} sessionById={sessionsById.get.bind(sessionsById)}>
            <div
              ref={listScrollRef}
              onScroll={handleListScroll}
              style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}
            >
              {loading && (
                <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
                  {t("sidebar.loading")}
                </div>
              )}
              {!loading && error && (
                <div style={{ padding: "12px 14px", color: "var(--danger, #f87171)", fontSize: 12 }}>
                  {error}
                </div>
              )}
              {!loading && !error && filteredSessions.length === 0 && draftsForTree.length === 0 && (
                <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
                  {t("sidebar.noSessions")}
                </div>
              )}
              {(() => {
                // 树虚拟化：DFS 拍平成可见行数组（折叠子树不展开），窗口只挂载可见 ± overscan 行
                const flatRows = flattenSessionTree(sessionTree, 0, collapsedIds);
                const indices = getSessionListIndices(
                  flatRows.length,
                  listScrollTop,
                  listViewportH,
                  flatRows.findIndex((row) => row.node.session.id === focusedSessionId),
                );
                return (
                  <div style={{ position: "relative", height: flatRows.length * SESSION_LIST_ITEM_HEIGHT }}>
                    {indices.map((index) => {
                      const row = flatRows[index];
                      return (
                        <div
                          key={row.node.session.id}
                          onFocus={() => setFocusedSessionId(row.node.session.id)}
                          onBlur={() => setFocusedSessionId(null)}
                          style={{ position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT, left: 0, right: 0 }}
                        >
                          <SessionTreeItem
                            node={row.node}
                            depth={row.depth}
                            selectedSessionId={selectedSessionId}
                            runningSessionIds={runningSessionIds}
                            unreadSessionIds={unreadSessionIds}
                            onSelectSession={handleSelectSessionFromList}
                            onRenamed={() => void refreshSessions()}
                            onSessionDeleted={(id) => {
                              removePendingDraft(id);
                              onSessionDeleted?.(id);
                              refreshListChannels(); // 左栏渲染 scoped 桶，只刷全量则删掉的行残留
                            }}
                            isDraft={draftIds.has(row.node.session.id)}
                            collapsed={collapsedIds.has(row.node.session.id)}
                            onToggleCollapse={() => toggleSessionCollapsed(row.node.session.id)}
                            locale={locale}
                            isPinned={pinnedIds.has(row.node.session.id)}
                            onTogglePin={() => void togglePinSession(row.node.session.id)}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </SessionSearchDock>
    </>
  );
}

/** SidebarDock —— 旧 sidebarProjects 回退壳（契约/形态不变）：折叠头 + SidebarList。
 *  sidebarContent 接管态不走这里（SidebarContentDock 以 DockBody 常驻区块渲染 SidebarList）。
 *  分支 chip 方案 §3：折叠头行右端接 ⎇ chip + 共享面板（与接管态同款；折叠态 chip 照常可点，
 *  chip 点击 stopPropagation 不与折叠互扰）。 */
export function SidebarDock(props: SidebarDockProps) {
  const [projectsOpen, setProjectsOpen] = useState(() => {
    try { return localStorage.getItem(PROJECTS_COLLAPSED_KEY) !== "1"; }
    catch { return true; }
  });
  // chip 需要的 cwd 真相在 SidebarList 内部选择——经 onCwdChange 包装镜像到这里
  const [chipCwd, setChipCwd] = useState<string | null>(props.cwd ?? null);
  const handleCwdChange = useCallback((c: string) => {
    setChipCwd(c);
    props.onCwdChange?.(c);
  }, [props.onCwdChange]);
  const worktree = useWorktree(chipCwd, handleCwdChange, props.sessionListVersion);
  // 新活动蓝点（语义不变：其他工作区有 running/unread）
  const store = useStore();
  const runningIds = (store.running ?? new Set<string>()) as Set<string>;
  // 活动蓝点：有会话在跑即亮（含当前项目），或其他工作区有未读（2026-09-17 语义修订）
  // 活动蓝点：**其他工作区**有运行中/未读即亮（与 SidebarList 的 hasOtherWorkspaceActivity 同语义；
  // 当前项目自身活动在列表行内可见，不计入——2026-09-17 去重回归）
  const hasOtherActivity = useMemo(() => {
    const key = chipCwd ? normalizeWorkspaceKey(chipCwd) : null;
    return [...projectActivity.entries()].some(
      ([k, a]) => k !== key && (a.running > 0 || a.unread > 0),
    );
  }, [projectActivity, chipCwd]);
  const chip = useBranchChip({ cwd: chipCwd, homeDir: props.homeDir ?? "", worktree, onCwdChange: handleCwdChange });
  const pickerOpenerRef = useRef<() => void>(() => {});
  const bindPickerOpener = useCallback((fn: () => void) => { pickerOpenerRef.current = fn; }, []);
  const openProjectsAndPicker = useCallback(() => {
    setProjectsOpen(true); // 折叠时先展开
    setTimeout(() => pickerOpenerRef.current(), 60);
  }, []);
  const listProps: SidebarDockProps = { ...props, onCwdChange: handleCwdChange, worktree, chipBadge: chip.badge, bindPickerOpener };
  // 折叠头右端 = 新活动蓝点（独立于 chip——非 git/引擎缺席也显示）
  const activityDot = hasOtherActivity ? (
    <span title={t("sidebar.newActivity")} aria-label={t("sidebar.newActivity")}
      style={{ width: 5, height: 5, borderRadius: "50%", marginRight: 2, flexShrink: 0, display: "inline-block",
        background: "color-mix(in srgb, var(--accent) 82%, transparent)",
        boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent)" }} />
  ) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
      {/* ▾ 项目 / PROJECTS —— 折叠头（persist 键存「折叠」语义，与历史键兼容）；
          右端 = ⎇ 分支 chip + 新活动蓝点（chip 内含，stopPropagation 互不干扰） */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          const next = !projectsOpen;
          setProjectsOpen(next);
          try { localStorage.setItem(PROJECTS_COLLAPSED_KEY, next ? "0" : "1"); } catch { /* ignore */ }
        }}
        onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProjectsOpen((v: boolean) => !v); } }}
        style={{
          display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
          padding: "6px 10px", background: "none", border: "none",
          color: "var(--text-muted)", cursor: "pointer", fontSize: 11,
          fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left",
        }}
      >
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: projectsOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
        >
          <polyline points="3 2 7 5 3 8" />
        </svg>
        项目 / Projects
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, paddingRight: 2, cursor: "pointer" }}
          onClick={(e) => { e.stopPropagation(); openProjectsAndPicker(); }}
          title={t("sidebar.newActivity")}
          role="button"
          tabIndex={0}
          onKeyDown={(e: any) => { if (e.key === "Enter") { e.stopPropagation(); openProjectsAndPicker(); } }}
        >
          {activityDot}
        </span>
      </div>
      {chip.overlay}
      {projectsOpen && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <SidebarList {...listProps} />
        </div>
      )}
    </div>
  );
}

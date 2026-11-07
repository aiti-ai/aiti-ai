/**
 * session-manager · SidebarContentDock —— 左栏整块接管编排器（sidebar 统一 dock 方案 §3.3）。
 *
 * sidebarContent（AppShell 层）接管态布局：
 *   Header（renderTitle 工厂 + ToolbarDock 新建/加文件夹/搜索/刷新 + renderSlot("sidebar")）
 *   + DockStack（aiti-float 服务容器：常驻区块 = 项目(0)；dockable 区块 = 定时任务(1，
 *     aiti-ai-schedule，v4 对齐分组上对齐) + 文件夹×N(2，aiti-folder 动态 faces) +
 *     任务/停靠面板(3+，dock 到 sidebar:* 族即入栈)；上对齐组钉顶、下对齐组钉底）)
 *   + 底部（renderSidebarFooter 工厂 + renderSlot("sidebarFooter")）。
 *
 * 文件夹多实例（folder-dock v2）：faces 与清单归 aiti-folder（localStorage 单一事实源 +
 * 事件）；本项目切换 cwd → syncFolderForCwd 自动开新文件夹实例；未钉 FIFO 保留 3 个。
 *
 * 宿主透传契约（§3.4 sidebarContentExtra）：组件工厂直出宿主元素（单渲染实例下
 * element.type=宿主组件引用天然合法），数据/回调全量透传；宿主 SessionSidebar 接管态
 * 零渲染、零 sm: 接线（刷新绿勾 = 本组件 store 刷新完成驱动，宿主零反馈代码）。
 *
 * 初始恢复（URL ?session= / 默认项目自动选）：原宿主 SessionSidebar 恢复 effect 的
 * 同构迁移——接管态宿主不挂载，恢复语义由本组件承担。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, apiUrl, getExtService, onExtServiceChange, ensureMaterialized, renderSlot } from "./host-shim";
import { useStore, refreshSessions, refreshWorkspaces, refreshProjectSessions, getProjectSessionsTarget, type WorkspaceEntry } from "./store";
import { SidebarList } from "./sidebar-dock";
import { getRecentProjects, getProjectActivity, normalizeWorkspaceKey, type SessionInfo } from "./sidebar/pure";
import { useWorktree } from "./sidebar/use-worktree";
import { useBranchChip } from "./sidebar/branch-chip";
import { DockBody, readBlockCollapsed, writeBlockCollapsed, seedBlockCollapsedDefault, present, sidebarZoneOf, SIDEBAR_COLLAPSE_PREFIX } from "../../../_shared/ext-float-dock";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
// 跨扩展复用（构建期内联，DirectoryBrowser 先例）：aiti-folder 的文件夹多实例生命周期。
// 区块 faces（左栏栈/浮窗/右栏）由 aiti-folder entry 动态注册（folder-dock v2）；
// 编排器只负责：项目切换自动开新文件夹实例（syncFolderForCwd）+ ＋ 选择器入口。
import {
  syncFolderForCwd,
  openFolderInstance,
  readFolderInstances,
  folderItemKey,
  INSTANCES_EVENT,
} from "../../../aiti-folder/client/src/folder-dock";
// 薄壳拆分（§5.1）：加文件夹的 aiti-folder DirectoryBrowser 懒 chunk——folderPickerOpen
// 门控才 import（跨扩展复用件不随首屏；aiti-folder host-shim 副本仍在 entry chunk
// （setAitiFolderCtx 注入），本 chunk 复用同一实例，ctx 单实例不受拆包影响）
import { createLazyModule, LazyMount } from "../../../_shared/ext-lazy";
const dirBrowserRef = createLazyModule(() => import("../../../aiti-folder/client/src/directory-browser"));

/* ── 未读标记（宿主同 key 持久化：pi-web:unread-session-ids——回退/接管两态共享）── */
const UNREAD_KEY = "pi-web:unread-session-ids";
function loadUnreadSessionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch { /* ignore */ }
  return new Set();
}
function saveUnreadSessionIds(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(UNREAD_KEY);
    else localStorage.setItem(UNREAD_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

const DOCK_STACK_SERVICE = "aiti-float.dockstack";
/** 应用中心（aiti-app-center）：DockStack 全折叠空白的填充物（docs/aiti-app-center-plan.md）。
 *  软依赖——服务缺席（扩展禁用/旧部署）时空白照旧，其余零影响。 */
const APP_CENTER_SERVICE = "aiti-app-center.api";

/** aiti-ai-schedule 面板 itemKey（schedule-app SCHED_KEY 同源契约）。本地常量而非跨扩展
 *  import：只为一个字符串内联整个 schedule-app 模块图不值得（DirectoryBrowser 先例是
 *  有意复用组件才内联）。 */
const SCHED_KEY = "aiti-ai-schedule:panel";

/** 懒扩展静态条目（未物化）的区块壳：直接用本 bundle 的 DockBody 渲染——
 *  头行与物化后的真 face 完全一致（箭头 + 标题 + ⇱ detach + ⋮ 区块操作，同一折叠/排序
 *  记忆键），零「点击加载」字样；仍然不预加载内容代码，展开时才由容器 ensureMaterialized
 *  → 注册条目同 key 覆盖 → 真 face 无缝接管。 */
function StaticDockShell(p: {
  itemKey: string; blockKey?: string; title?: string; chrome?: "section" | "tab"; kind?: "dockable" | "reserved";
  zones?: any[]; defaultZone?: string; children?: any;
}) {
  return (
    <DockBody
      itemKey={p.itemKey}
      blockKey={p.blockKey ?? p.itemKey}
      title={p.title}
      chrome={p.chrome ?? "section"}
      kind={p.kind ?? "dockable"}
      zones={p.zones}
      defaultZone={p.defaultZone}
    >
      {p.children}
    </DockBody>
  );
}

export function SidebarContentDock(props: Record<string, any>) {
  const store = useStore();
  const {
    renderTitle,
    renderSidebarFooter,
    selectedSession,
    selectedSessionId,
    selectedCwd: cwdProp,
    refreshKey,
    explorerRefreshKey,
    initialSessionId,
    skipInitialProjectSelection,
    onSelectSession,
    onNewSession,
    onOpenById,
    onSessionDeleted,
    onCwdChange,
    onOpenFile,
    onOpenFolder,
    onAtMention,
    onBackgroundTaskDone,
    onRunningSessionIdsChange,
    onSessionsChange,
    onInitialRestoreDone,
    isMobile,
    onCloseSidebar,
  } = props;

  // busy 转圈动画 keyframes（一次性注入；id 守卫防重）
  (function ensureSpinKeyframes() {
    try {
      if (document.getElementById("sm-dock-spin-style")) return;
      const style = document.createElement("style");
      style.id = "sm-dock-spin-style";
      style.textContent = "@keyframes sm-dock-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
      (document.head || document.documentElement).appendChild(style);
    } catch { /* noop */
    }
  })();

  /* ── home dir（~ 展示；一次性拉取）── */
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => {
    let alive = true;
    // 宿主共享服务 pi-web.home（lib/home-dir 单例，跨消费面一次请求）；缺席回退自拉。
    const svc = getExtService<{ ensure: () => Promise<string | null> }>("pi-web.home");
    const p = svc?.ensure
      ? svc.ensure()
      : dedupeFetch(apiUrl("/api/home")).then((r) => r.json()).then((d: any) => (d?.home as string) ?? null).catch(() => null);
    void p.then((dir) => { if (alive && dir) setHomeDir(dir); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  /* ── DockStack 服务（aiti-float；上/下线事件驱动重渲染，缺席降级直排 §3.8）── */
  const [, force] = useState(0);
  useEffect(() => {
    const off = onExtServiceChange((key, phase) => { if (key === DOCK_STACK_SERVICE || key === APP_CENTER_SERVICE) force((v) => v + 1); });
    return off;
  }, []);
  const stackApi = getExtService<{ DockStack: (p: any) => unknown }>(DOCK_STACK_SERVICE);
  const appCenterApi = getExtService<{ renderAppCenter: () => unknown }>(APP_CENTER_SERVICE);

  /* ── 头部工具条状态 ── */
  const [searchOpen, setSearchOpen] = useState(false);
  // 开搜索时自动展开项目区块（搜索输入在区块内部——折叠态下开关要有可见效果）
  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open;
      if (next && readBlockCollapsed("projects")) writeBlockCollapsed("projects", false);
      return next;
    });
  }, []);
  const [searchQuery, setSearchQuery] = useState("");
  // 刷新绿勾（验收 #1）：in-flight 转圈 → store 刷新真完成才绿 2s（store 完成语义 =
  // refreshSessions promise 落地；本组件宿主零反馈代码的对应面：扩展全责）
  const [refreshState, setRefreshState] = useState<"idle" | "busy" | "done">("idle");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshBusyRef = useRef(false);
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);
  const doRefresh = useCallback(async () => {
    if (refreshBusyRef.current) return;
    refreshBusyRef.current = true;
    setRefreshState("busy");
    try {
      // [通道拆分] 刷新绿勾覆盖三条通道：全量（宿主 catalog）+ workspaces + 当前项目 scoped。
      // scoped 用 getProjectSessionsTarget()（当前目标 key），不能用 store.projectSessionsKey
      // ——那是上次「成功落地」的 key，切项目卡死时停在旧 workspace，点刷新会刷错项目
      //（2026-09-18 跨 workspace 卡死修复）。
      await Promise.allSettled([
        refreshSessions({ force: true }),
        refreshWorkspaces(undefined, true),
        refreshProjectSessions(getProjectSessionsTarget(), { refresh: true }),
      ]);
    } catch { /* keep last */ }
    refreshBusyRef.current = false;
    // 真完成才绿 2s（验收 #1：无反馈缺陷闭环——in-flight/busy/完成三态全由本 store 链路驱动）
    setRefreshState("done");
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setRefreshState("idle"), 2000);
  }, []);

  /* ── 选中 cwd（SidebarList 内部持有 + 头部新建按钮联动经桥）── */
  const [cwdState, setCwdState] = useState<string | null>(cwdProp ?? null);
  const cwdRef = useRef<string | null>(cwdProp ?? null);
  // 宿主 cwd 变化镜像（外部切换会话/URL 恢复/new-session）：原宿主 SidebarDock 同款
  // prop 同步——picker/worktree 高亮跟随；picker 本地选 worktree 不回写 prop，无回环。
  // ⚠ prop 驱动的新 cwd 必须回写 onCwdChange（回退态 SessionSidebar 通知 effect 的
  // 同构语义）：宿主 handleSelectSession 只推进 project identity，activeCwd 靠侧栏通知
  // 更新；接管态只镜像不回写时 activeCwd 停在 null/旧值——URL ?session= 恢复后实测
  // 右栏「打开当前工作目录」回退默认目录 ~/pi-cwd-*（窗口标题/快捷键新会话 cwd 同错）。
  // 带 selectedSession 的 projectRoot/Key 回写：worktree 会话 cwd 与 projectKey 不同，
  // 缺身份会被宿主误判为跨项目切换。以 (cwd,key) 去重（宿主同款语义），onCwdChange
  // 身份高频变化导致的 effect 重跑不会重复通知。
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    // ⚠ prop 为 null 时**保留**当前 cwd（不清 ref/state）：核心 bug 修复（2026-09-14）
    // ——宿主跨项目切换后 setSelectedSession(null) → selectedCwd prop 变 null;
    // 若此处无条件清空 cwdRef.current，后续 store.sessions 更新（心跳/刷新）会让
    // 下方「默认项目自动选」effect 误判从未选过项目，把 cwd 弹回最近活跃项目
    // （用户点击的 workspace 切换被立刻回退，左侧切换失效）。宿主原版 SessionSidebar
    // 同款语义：selectedCwdProp 有值才同步，null 不动本地值。
    if (!cwdProp) return;
    cwdRef.current = cwdProp;
    setCwdState(cwdProp);
    const same = selectedSession && selectedSession.cwd === cwdProp ? selectedSession : null;
    const key = same ? (same.projectKey ?? same.projectRoot ?? same.cwd) : null;
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === cwdProp && previous.key === key) return;
    lastNotifiedProjectRef.current = { cwd: cwdProp, key };
    onCwdChange?.(cwdProp, same?.projectRoot ?? null, same?.projectKey ?? null);
  }, [cwdProp, selectedSession, onCwdChange]);
  const handleCwd = useCallback((c: string) => {
    cwdRef.current = c;
    setCwdState(c);
    onCwdChange?.(c);
  }, [onCwdChange]);
  // 最新回调 ref：初始恢复 effect 依赖不含 onCwdChange（宿主 handleCwdChange 引用随
  // activeCwd/selectedSession 等状态高频变化，入依赖会反复重跑），经 ref 取最新闭包。
  const onCwdChangeRef = useRef(onCwdChange);
  useEffect(() => { onCwdChangeRef.current = onCwdChange; });

  /* ── 新建会话（宿主 handleNewSession 同构：客户端临时 uuid，首条消息才落盘）── */
  const handleNewSessionClick = useCallback(() => {
    const cwd = cwdRef.current ?? cwdState;
    if (!cwd) return;
    const tempId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [cwdState, onNewSession]);

  /* ── 初始恢复（原宿主恢复 effect 同构迁移：?session= 恢复 / 默认项目自动选）── */
  const restoredRef = useRef(false);
  // URL 恢复定案前挂起默认项目自动选：initialSessionId 由宿主 post-hydration 派生
  //（首帧为 null），且恢复 effect 会随 store.sessions/workspaces 落地多次重跑——仅靠
  // restoredRef 防不住：重跑时 restoredRef 已 true 会直接落入默认选分支，把右侧切到
  // 新建会话窗口（「正在打开会话 → 新会话 → 会话」闪现的元凶）。独立 effect 在
  // initialSessionId 出现时置位，恢复定案（命中/成功/失败）时清除。
  const restorePendingRef = useRef(false);
  useEffect(() => {
    restorePendingRef.current = Boolean(initialSessionId);
  }, [initialSessionId]);
  useEffect(() => {
    const sessions = (store.sessions ?? []) as SessionInfo[];
    const workspaces = (store.workspaces ?? []) as WorkspaceEntry[];
    // [通道拆分] 快通道 workspaces 先落地即可进行默认项目自动选（不等待 1MB 全量）
    if ((sessions.length === 0 && workspaces.length === 0) || skipInitialProjectSelection) return;
    // URL 恢复优先（?session= 可能晚于首帧到达——宿主 post-hydration 才派生 initialSessionId）
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = sessions.find((s) => s.id === initialSessionId);
      if (target) {
        restorePendingRef.current = false; // 命中即定案
        cwdRef.current = target.cwd;
        setCwdState(target.cwd);
        onSelectSession?.(target, true);
        return;
      }
      // 列表未命中 → 宿主按 id 打开（live-bridge 会话 socket attach 可中）。
      // initialRestore 标记：宿主 404 时据此清失效 last-open 记录 + 立即清 URL。
      // **await 结果**：恢复挂起期间不做默认项目自动选——否则 onCwdChange 会先把
      // 右侧切到新建会话窗口，?session= 刷新呈现「先新会话后跳转」的闪现。恢复
      // 成功（宿主已选中会话）即 return；失败才 fall through 下方默认项目自动选
      //（无效 ?session= 的清理由宿主 404 分支 + 恢复完成后的 onCwdChange 链承担，
      // 语义与回退态 SessionSidebar 对齐）。
      void (async () => {
        let ok = false;
        try {
          ok = Boolean(await onOpenById?.(initialSessionId, { initialRestore: true }));
        } catch {
          ok = false;
        }
        onInitialRestoreDone?.();
        restorePendingRef.current = false; // 定案：恢复成功即止，失败才补默认选
        if (ok) return;
        if (cwdRef.current === null) {
          const projects = sessions.length > 0
            ? getRecentProjects(sessions)
            : workspaces.map((w) => ({ key: w.key, root: w.root }));
          if (projects.length > 0) {
            cwdRef.current = projects[0].root;
            setCwdState(projects[0].root);
            onCwdChangeRef.current?.(projects[0].root);
          }
        }
      })();
      return; // 恢复挂起：默认项目自动选延后到恢复结果
    }
    // 恢复挂起中：默认项目自动选不得触发（effect 随 store 落地重跑的防护）
    if (restorePendingRef.current) return;
    // 默认项目自动选。原宿主语义并非「仅本地展示」：回退态 selectedCwd 变化会经
    // 通知 effect 回写宿主（onCwdChange → 宿主 setActiveCwd → effectiveNewSessionCwd
    // 成立 → 右侧从「开始使用」占位符切到新建会话窗口）。接管态迁移时漏发该通知，
    // 即「左侧项目已高亮、右侧停留初始页」不同步——此处补发，语义对齐回退态。
    if (cwdRef.current === null) {
      // 全量未到时用 workspaces 兜底（项目集合同源）；全量到时走 getRecentProjects 原逻辑
      const projects = sessions.length > 0
        ? getRecentProjects(sessions)
        : workspaces.map((w) => ({ key: w.key, root: w.root }));
      if (projects.length > 0) {
        cwdRef.current = projects[0].root;
        setCwdState(projects[0].root);
        onCwdChangeRef.current?.(projects[0].root);
      }
    }
  }, [store.sessions, store.workspaces, initialSessionId, skipInitialProjectSelection, onSelectSession, onOpenById, onInitialRestoreDone]);

  /* ── running/unread（store 权威；宿主过渡逻辑的接管态迁移）── */
  const runningSessionIds = store.running as Set<string>;
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const prevRunningRef = useRef<Set<string>>(new Set());
  useEffect(() => { saveUnreadSessionIds(unreadSessionIds); }, [unreadSessionIds]);
  useEffect(() => {
    const prev = prevRunningRef.current;
    const completedInBackground = [...prev].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !prev.has(id));
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((p) => {
        const next = new Set(p);
        runningSessionIds.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    if (completedInBackground.length > 0) onBackgroundTaskDone?.();
    prevRunningRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, onBackgroundTaskDone]);
  useEffect(() => { onRunningSessionIdsChange?.(runningSessionIds); }, [runningSessionIds, onRunningSessionIdsChange]);

  /* ── 文件夹/任务区块 provider 物化（懒扩展跳板）+ 文件夹多实例（v2：faces 在 aiti-folder）── */
  useEffect(() => { void ensureMaterialized("aiti-folder"); }, []);
  // 应用中心（懒扩展）：挂载即物化——DockStack 全折叠空白需要它随时可渲染（bundle 纯 UI 无重依赖）
  useEffect(() => { void ensureMaterialized("aiti-app-center"); }, []);
  // [开页方案 §1 F4，2026-09-12] 子代理舰队 / 定时任务区块不再在此处物化：
  // 二者的 sidebarExplorerDock 声明已由宿主登记为 manifest 静态条目，DockStack 会渲染
  // 「静态壳」（标题+折叠态），用户展开/点击时才 ctx.ensureMaterialized —— 开页零拉取
  //（二者合计 ~200KB 解码）。物化后注册条目同 key 覆盖静态条目，真 face 无缝接管。
  // 定时任务区块仍需 present 入栈（默认入栈语义不变，见下方 schedAutoDocked effect）。
  // 项目切换联动：当前 cwd 自动开一个文件夹区块（aiti-folder faces 注册后入栈；
  // 未钉实例 FIFO 保留 3 个，钉住豁免——清单语义在 folder-dock）
  useEffect(() => { syncFolderForCwd(cwdState); }, [cwdState]);
  // 文件夹区块常驻自动入栈（dock 方案 §3.1：once-per-key-per-mount；用户关闭本会话不回弹，
  // 刷新恢复默认存在）。闸门 = stackApi（aiti-float dockstack 服务上线后才 present——
  // 否则早于 float 状态机安装的 present 会落进 _shared 降级 store，真状态机永远读到 closed）。
  // 服务上线事件（onExtServiceChange→force）与 instances 变化事件都会重扫，安装顺序免疫。
  // auto 标记：恢复性入栈，不当成用户打开——小屏侧栏 overlay 不被刷新拉起。
  const folderAutoDockedRef = useRef<Set<string>>(new Set());
  const folderInstancesKey = readFolderInstances().join("\n");
  useEffect(() => {
    if (!stackApi) return;
    const scan = () => {
      for (const p of readFolderInstances()) {
        const key = folderItemKey(p);
        if (folderAutoDockedRef.current.has(key)) continue;
        folderAutoDockedRef.current.add(key);
        try { present(key, "open", { auto: true }); } catch { /* ignore */ }
      }
    };
    scan();
    window.addEventListener(INSTANCES_EVENT, scan);
    return () => window.removeEventListener(INSTANCES_EVENT, scan);
  }, [stackApi, folderInstancesKey]);
  // 定时任务区块常驻入栈（v4 对齐分组：核心区块上对齐）。用**显式 dock 命令**而非
  // present(open)：老用户 dockpref=旧默认 right-panel 时，open 会被带去右栏还自动展开
  // 右栏；dock:sidebar:<key> 一步落左栏并顺带改写偏好（与 seedDockDefault 新默认收敛）。
  // once-per-mount 守卫：用户 ⋮ 关闭本会话不回弹，刷新恢复默认存在（文件夹区块同语义）；
  // 闸门 = stackApi（present 早于 float 状态机安装会落 _shared 降级 store——§10.3 同坑）。
  const schedAutoDockedRef = useRef(false);
  useEffect(() => {
    if (!stackApi || schedAutoDockedRef.current) return;
    schedAutoDockedRef.current = true;
    // [开页方案 §1 F4] 不再等 ensureMaterialized：静态壳即区块本体；present 只需同步（入栈后
    // 壳可见、默认折叠），展开时才拉 aiti-ai-schedule。
    // auto 标记：恢复性入栈（非用户打开）——小屏侧栏 overlay 不被刷新拉起。
    try { present(SCHED_KEY, `dock:${sidebarZoneOf(SCHED_KEY)}`, { auto: true }); } catch { /* ignore */ }
  }, [stackApi]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  /* ── 默认折叠态政策（仅当区块尚无折叠记录时播种；用户手动折叠/展开后永不覆盖）──
   *  项目默认展开、文件夹默认折叠——跨刷新保持；文件夹播种已移入 folder-dock
   *  declareFolderInstance（v2 faces 注册链路，首渲染前生效）。同步在 blocks 构造前
   *  执行：StackCell 首次渲染即读到种子值，避免「先展开再折叠」闪烁。 */
  seedBlockCollapsedDefault("projects", false);
  // 任务区块默认折叠（用户拍板 2026-09-16；单展开手风琴下默认只展开项目）。
  // 首批曾播种「展开」的部署存有老记录（"0"）——seedBlockCollapsedDefault 只填缺席，
  // 一次性迁移纠正（flag 防重入；此后用户手动展开/折叠自由、永不覆盖）。
  try {
    if (!localStorage.getItem("pi:sidebar-dock:task-collapsed-v2")) {
      localStorage.setItem("pi:sidebar-dock:task-collapsed-v2", "1");
      localStorage.setItem(SIDEBAR_COLLAPSE_PREFIX + SCHED_KEY, "1");
    }
  } catch { /* ignore */ }
  seedBlockCollapsedDefault(SCHED_KEY, true);
  // 项目/任务互斥已升级为 DockStack 容器级「单展开手风琴」（全栈任一区块展开即折叠
  // 其他展开者，aiti-float dockstack.ts 统一裁决）——编排器不再单做两块互斥。

  /* ── 区块集（常驻：项目(0)；文件夹×N 已升级为 aiti-folder 动态 dockable faces（pt 2），
     其余 dockable 由 DockStack 从 slot 读，3+）── */
  // 分支 chip（git-ops 方案 §3）：worktree 上提 + 折叠头右端 ⎇ chip + 共享面板
  const worktree = useWorktree(cwdState, handleCwd, null);
  // 活动蓝点（语义回归 2026-09-17）：**其他工作区**有运行中/未读即亮（与 picker 行内旧活动点
  // 去重——后者已摘除，本点唯一）。当前项目自身的活动在列表行内可见（spinner/波点），不计入。
  const hasOtherActivity = useMemo(() => {
    const sessions = (store.sessions ?? []) as SessionInfo[];
    // key 归一：worktree 数据已加载（面板打开过）用 projectKey；lazy 后常缺席 → 会话行
    // projectKey/projectRoot 兑底（worktree 会话 cwd 与项目 key 不同，不兑底会误亮蓝点）
    const hit = cwdState ? sessions.find((s) => s.cwd === cwdState) : undefined;
    const key = cwdState
      ? (worktree.state && worktree.state.forCwd === cwdState
          ? worktree.state.projectKey
          : (hit?.projectKey ?? hit?.projectRoot ?? normalizeWorkspaceKey(cwdState)))
      : null;
    return [...getProjectActivity(sessions, runningSessionIds, unreadSessionIds)].some(
      ([k, a]) => k !== key && (a.running > 0 || a.unread > 0),
    );
  }, [cwdState, store.sessions, runningSessionIds, unreadSessionIds, worktree.state]);
  const chip = useBranchChip({ cwd: cwdState, homeDir, worktree, onCwdChange: handleCwd });
  // 蓝点点击 → 展开项目区块 + 弹出 workspace 下拉（看哪个项目有 ●）
  const pickerOpenerRef = useRef<() => void>(() => {});
  const bindPickerOpener = useCallback((fn: () => void) => { pickerOpenerRef.current = fn; }, []);
  const openProjectsAndPicker = useCallback(() => {
    try { if (readBlockCollapsed("projects")) writeBlockCollapsed("projects", false); } catch { /* ignore */ }
    setTimeout(() => pickerOpenerRef.current(), 60); // 等区块展开挂载
  }, []);
  // 折叠头右端 = 活动蓝点（独立于 chip——非 git/引擎缺席也显示；chip 在项目选择行右端）
  const activityDotEl = (
    <span title={t("sidebar.newActivity")} aria-label={t("sidebar.newActivity")}
      style={{ width: 5, height: 5, borderRadius: "50%", background: "color-mix(in srgb, var(--accent) 82%, transparent)",
        boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent)", display: "inline-block" }} />
  );

  const blocks = [
    {
      key: "projects",
      title: t("sm.dockProjects"),
      priority: 0,
      align: "top" as const, // 对齐分组（v4）：核心区块上对齐
      fill: true,
      render: () => (
        <DockBody itemKey="projects" blockKey="projects" title={t("sm.dockProjects")} chrome="section" kind="reserved"
          headerActions={hasOtherActivity ? [{ id: "projects-activity", title: t("sidebar.newActivity"), icon: activityDotEl, visibility: "always", onClick: () => openProjectsAndPicker() }] : undefined}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
            <SidebarList
              cwd={cwdState ?? undefined}
              homeDir={homeDir}
              refreshKey={refreshKey}
              sessionListVersion={null}
              unreadSessionIds={unreadSessionIds}
              selectedSessionId={selectedSessionId ?? null}
              selectedSession={selectedSession ?? null}
              explorerOpen={Boolean(cwdState)}
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onCwdChange={handleCwd}
              onSelectSession={(s: SessionInfo, entryId?: string, blockIndex?: number) => onSelectSession?.(s, false, entryId, blockIndex)}
              onSessionDeleted={(id: string) => { onSessionDeleted?.(id); }}
              onSessionsChange={onSessionsChange}
              onRunningSessionIds={onRunningSessionIdsChange}
              worktree={worktree}
              chipBadge={chip.badge}
              bindPickerOpener={bindPickerOpener}
            />
          </div>
        </DockBody>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* Header：Title + ToolbarDock + sidebar 扩展点（原宿主结构同构迁移） */}
      <div style={{ padding: "12px 10px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          {typeof renderTitle === "function" ? renderTitle() : null}
          <div style={{ display: "flex", gap: 6 }}>
            {/* 新建（宿主同款；cwd 缺席禁用） */}
            <button
              onClick={handleNewSessionClick}
              disabled={!cwdState}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: cwdState ? "var(--text-muted)" : "var(--text-dim)",
                cursor: cwdState ? "pointer" : "not-allowed",
                height: 32, paddingLeft: 10, paddingRight: 12,
                borderRadius: 7, fontSize: 12, fontWeight: 500, letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              title={cwdState ? t("sidebar.newSessionTitle", { path: cwdState }) : t("sidebar.selectProject")}
              onMouseEnter={(e: any) => {
                if (!cwdState) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e: any) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = cwdState ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {t("sidebar.new")}
            </button>
            {/* 加文件夹（多实例 +；走 aiti-folder DirectoryBrowser） */}
            <button
              type="button"
              onClick={() => setFolderPickerOpen(true)}
              title={t("sm.dockAddFolder")}
              aria-label={t("sm.dockAddFolder")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "var(--bg-hover)", border: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", width: 32, height: 32,
                borderRadius: 7, padding: 0, flexShrink: 0,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                <line x1="12" y1="10" x2="12" y2="16" /><line x1="9" y1="13" x2="15" y2="13" />
              </svg>
            </button>
            {/* 搜索开关 */}
            <button
              type="button"
              onClick={toggleSearch}
              title={t("sidebar.toggleSessionSearch")}
              aria-label={t("sidebar.toggleSessionSearch")}
              aria-expanded={searchOpen}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: searchOpen ? "var(--bg-selected)" : "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: searchOpen ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer", width: 32, height: 32, borderRadius: 7, padding: 0, flexShrink: 0,
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
              </svg>
            </button>
            {/* 刷新（绿勾 = store 刷新真完成驱动 2s；busy 转圈） */}
            <button
              onClick={() => { void doRefresh(); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: refreshState === "done" ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${refreshState === "done" ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: refreshState === "done" ? "var(--ok, #4ade80)" : "var(--text-muted)",
                cursor: "pointer", width: 32, height: 32, borderRadius: 7, padding: 0, flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e: any) => {
                if (refreshState === "done") return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e: any) => {
                if (refreshState === "done") return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
              title={t("sidebar.refresh")}
            >
              {refreshState === "busy" ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ animation: "sm-dock-spin 0.8s linear infinite", transformOrigin: "center" }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : refreshState === "done" ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--ok, #4ade80)" }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
            {/* sidebar 扩展点（原宿主同构：标题行内联——「运行会话」快速切换按钮等）。
                放按钮组末尾随组贴右；勿独立成行——会把按钮挤到下一行（回归过一次） */}
            {renderSlot("sidebar")}
            {/* 收起（小屏全屏抽屉的关闭按钮，宿主 extra 下发；桌面无抽屉不渲染）。
                放组末最右：全屏后右上角就是退出抽屉的出口，与宿主顶栏面板图标同款 */}
            {isMobile && typeof onCloseSidebar === "function" ? (
              <button
                type="button"
                onClick={onCloseSidebar}
                title={t("sidebar.hide")}
                aria-label={t("sidebar.hide")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  color: "var(--text-muted)", cursor: "pointer", width: 32, height: 32,
                  borderRadius: 7, padding: 0, flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* DockStack：统一区块栈（aiti-float 服务；缺席降级 = 常驻区块直排 + slot 原样渲染）。
          slotExtra：文件夹 faces（aiti-folder 动态注册）所需宿主回调/会话 cwd 透传 */}
      {stackApi ? (
        <stackApi.DockStack
          blocks={blocks}
          dockSlot="sidebarExplorerDock"
          staticShell={StaticDockShell}
          filler={appCenterApi ? () => appCenterApi.renderAppCenter() : undefined}
          slotExtra={{
            cwd: cwdState,
            // fileName/folderName 兜底（2026-09-15 修复）：文件夹树回调只给路径（aiti-folder
            // TreeNode 单参调用），而宿主 handleOpenFile 的 fileName 是 tab.label 原料——
            // 缺省会让 FileIcons.getFileIcon(undefined) 直接崩（点击文件白屏）。
            onOpenFile: (p: string) => onOpenFile?.(p, p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p),
            onOpenFolder: (p: string) => onOpenFolder?.(p, p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p),
            onAtMention,
            gitRefreshKey: explorerRefreshKey,
          }}
        />
      ) : (
        <div data-ext-float-dock-stack="fallback" data-ext-float-dock-zone="sidebar" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          {blocks.map((b) => <div key={b.key} style={{ flex: b.fill ? "1 1 auto" : "0 0 auto", minHeight: 120, borderBottom: "1px solid var(--border)" }}>{b.render()}</div>)}
          {renderSlot("sidebarExplorerDock")}
        </div>
      )}

      {/* 底部：模型/技能/设置行 + sidebarFooter 扩展点（renderSidebarFooter 工厂直出宿主元素） */}
      {typeof renderSidebarFooter === "function" ? renderSidebarFooter() : null}

      {/* 分支面板弹层（portal 到 body；git-ops 方案 §2） */}
      {chip.overlay}

      {/* ＋ 添加文件夹（aiti-folder DirectoryBrowser；选择即追加实例（含配额），已存在则重新带到面前） */}
      {folderPickerOpen ? (
        <LazyMount
          active={folderPickerOpen}
          load={dirBrowserRef}
          pick="DirectoryBrowser"
          initialPath={cwdState ?? undefined}
          onSelect={(p: string) => { setFolderPickerOpen(false); openFolderInstance(p); }}
          onCancel={() => setFolderPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

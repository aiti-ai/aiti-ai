/**
 * session-manager extension entry.
 *
 * Cross-project session management: flat all-sessions panel (running first,
 * then recently completed, paginated + search + tag filter), tag tree with
 * colors, favorites, top-bar tag area, tag manager, kanban-ready data model.
 *
 * See docs/all-sessions-panel.zh-CN.md. Framework contract: lib/ext/types.ts.
 */
import { api } from "./server/api.ts";
import { readTagData } from "./server/tags-store.ts";
import { runtime, syncIndex, runArchive, loadSettings, saveSettings } from "./server/runtime.ts";
import { bindActivityPublisher, publishSessionActivity, resetActivityBusState } from "./server/activity-bus.ts";
import { ensureProviders, resolveExtId } from "./server/ext-sources.ts";
import { requestIndexVacuum } from "./lib/session-index-async.ts";
import { dirname, join } from "node:path";

let archiveTimer: ReturnType<typeof setInterval> | null = null;
let smConfigDir = ""; // services.tags 出口用（startup 时填充）

// ── 会话活动广播（列表行数据实时化，2026-09-14；数据帧化 2026-09-15）──────────
// 背景（用户实测「最新状态没及时更新，始终显示停止之前的状态」）：左栏列表此前只在
// running 集变化（会话开始/结束）时刷新——会话持续运行期间消息数/modified 一路增长，
// 却无任何刷新触发，行数据冻结在「开始运行那一刻」（实证：行显示 34 条/19 小时前，
// 实际该会话已 300+ 条、正在跑）。修复走事件驱动：agent 每次 message_end 落盘后经
// 总线广播 sm:session-activity，行数据随帧下发（服务端行缓存 + 事件增量更新，口径
// 与列表组装对齐），client 直接 patch store——从「信号帧 + 收帧再拉列表」升级为
// 「数据帧 + 零请求」。实现见 server/activity-bus.ts；总线缺席时静默（退化为原有行为，不致命）。

// 命名为模块常量：server.startup 经 ext.services.* 接入 ctx.services 出口（DI 方案 P1）
const ext = {
  id: "session-manager",
  name: "Session Manager",
  version: "0.2.0",
  icon: "icon.svg",
  client: "dist/session-manager.mjs",

  // 可选依赖（git-ops 方案 §3 软依赖）：aiti-git-ops 在位时折叠头出分支 chip + 共享面板；
  // 缺席/禁用 → chip 防御性隐藏（refs 404 门控），本扩展其余功能零影响。
  // aiti-app-center（应用中心，docs/aiti-app-center-plan.md）：DockStack 全折叠空白的填充物；
  // 缺席 → 空白照旧（无应用中心），其余零影响。
  optionalDependsOn: ["aiti-git-ops", "aiti-app-center"],

  // 功能级硬依赖（依赖与能力模型；sidebar 统一 dock 方案评审 5 拍板）：左栏整块接管
  // 的 DockStack 区块栈容器由 aiti-float 提供（cap "aiti-float.dockstack"）。硬语义 =
  // 本扩展启用时 aiti-float 不能被单独禁用（extman 硬阻止）——不存在「接管生效但
  // DockStack 缺席」的运行态，故编排器无需 DockStack 缺席降级分支（代码仍保留兜底）。
  dependsOn: ["aiti-float.dockstack"],

  // AI 自管理清单：AI 能帮我归档旧会话 / 找会话 / 整理标签
  ai: {
    manage: true,
    intro: "AI 能帮我归档旧会话、找到某个会话、整理会话标签",
    skills: "skills",
  },

  // 功能管理（extman「功能管理」区块逐项启停；契约 lib/ext types.ts ExtFeature）：
  // 顶栏搜索框默认关——全部会话面板内已有搜索，顶栏入口重复且挤占工具条空间；
  // 客户端条目带 feature: "toolbar.search"，宿主按此过滤显隐（extman 切换即时生效）。
  features: [
    { id: "toolbar.search", label: "顶栏会话搜索框", description: "顶栏（含 ⋯ 菜单）的会话搜索框；全部会话面板内已有搜索", group: "界面", default: false },
    { id: "behavior.favorite-icons", label: "收藏图标", description: "会话列表/看板/顶栏显示收藏（★）图标；关闭后收藏操作入口收敛到标签下拉的「收藏」项（标签下拉始终可用）", group: "界面", default: false },
    { id: "behavior.session-timeline", label: "会话行时间线按钮", description: "侧栏会话行悬停操作里显示「⎇ 时间线」按钮（aiti-git-trace 打开该会话的变更时间线）；全部会话面板行「⋯」菜单的时间线入口不受此开关影响", group: "界面", default: false },
    { id: "behavior.folder-quota", type: "string", label: "左栏文件夹区块保留数", group: "界面", value: "3", placeholder: "3",
      description: "切换项目时自动打开的文件夹区块数量上限（未钉住的先进先出；钉住的不占配额）。默认 3，可填 1-9，非法值回落 3。在 extman「功能管理」里改。" },
  ],

  // 跨扩展服务出口（additive，方案 aiti-doc-center-plan §4.7）：tag 词表 + 会话挂 tag 快照
  services: {
    get sessions() {
      return {
        version: 1,
        /**
         * 外部 agent 会话读取（唯一权威实现 = 本扩展 AgentAdapter 体系）。
         * id = 复合 id（如 "zcode:sess_xxx"）→ { meta, messages }（IndexedMessage[]）。
         * null = 未知 agent / 未激活源 / 解析失败。消费方（如 aiti-zcode-agent 回放）
         * 缺席时 fail-silent，不得自行重实现各 agent 存储 读取。
         */
        async parseSession(id: string): Promise<{ meta: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null> {
          try {
            await ensureProviders(smConfigDir);
            const resolved = resolveExtId(smConfigDir, id);
            if (!resolved) return null;
            // 源未激活时 parse 依旧可用（读取无副作用；激活只影响索引同步面）。
            // service: 伪路径对 DB 型 adapter（zcode/opencode 等）足够（其 parse 只认 sid）；
            // 文件型 adapter（claude-like/codebuddy/codex）需要真实路径——首次 parse 必空，
            // 回退 adapter.list() 按 sid 定位真实 ref（parseSession 恒走此路径，非热路径）。
            type ParsedT = { meta: Record<string, unknown>; messages: Array<Record<string, unknown>> };
            let parsed: ParsedT | null = null;
            try {
              parsed = (await resolved.adapter.parse({ sid: resolved.sid, path: `service:${id}` })) as ParsedT | null;
            } catch {
              parsed = null;
            }
            if (!parsed) {
              try {
                const hit = (await resolved.adapter.list()).find((r) => r.sid === resolved.sid);
                if (hit) parsed = (await resolved.adapter.parse(hit)) as ParsedT | null;
              } catch { /* list 不可用 → 保持 null */ }
            }
            return parsed;
          } catch {
            return null;
          }
        },
        /**
         * 已归档 session id 集合（archive 后原 jsonl 已进 .pwarc 容器，宿主 /api/sessions
         * 扫不到 → pi-web:open-session 静默失败）。消费方（aiti-doc-center）据此把归档
         * 会话的打开入口降级为 sm:open-archived 事件 → 本扩展 client 唤起归档查看器。
         * sync + fail-silent（索引缺席/异常返回 []），additive 不影响既有消费方。
         */
        archivedIds(): string[] {
          try {
            return (runtime(smConfigDir).index.archivedRows() as Array<{ id: string }>).map((r) => String(r.id));
          } catch {
            return [];
          }
        },
      };
    },
    get tags() {
      return {
        /** TagData 全量（{version, tags, sessionTags}）；version 为乐观锁，消费方做缓存 key */
        snapshot() {
          try { return readTagData(smConfigDir); } catch { return null; }
        },
      };
    },
  get hotwords() {
    return {
      async get(params = {}) {
        try {
          // 数据分层：configDir = <extRoot>/config，cache 在 extRoot 下
          const dbPath = join(dirname(smConfigDir), "cache", "index.sqlite");
          const { extractHotwordsFromDBAsync } = await import("./lib/hotwords.ts");
          return extractHotwordsFromDBAsync(dbPath, {
            cnCount: typeof params.cnCount === "number" ? params.cnCount : 20,
            enCount: typeof params.enCount === "number" ? params.enCount : 20,
            timeWeight: typeof params.timeWeight === "string" ? params.timeWeight : "none",
            includeUser: typeof params.includeUser === "boolean" ? params.includeUser : undefined,
            includeAi: typeof params.includeAi === "boolean" ? params.includeAi : undefined,
            cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : undefined,
            paths: Array.isArray(params.paths) ? params.paths.filter((x: unknown) => typeof x === "string" && x) : undefined,
          });
        } catch (e) {
          console.error("[session-manager] hotwords service failed:", e);
          return { cn: [], en: [], stats: { totalMessages: 0, analyzedSessions: 0, timeRange: "none" } };
        }
      },
    };
  },
  },
  // 索引库瘦身（schedule hook 函数任务，aiti-ai-schedule 聚合执行——不自造轮询）：
  // run 只做薄转发，真活在索引 worker 里跑（主线程零阻塞）；worker 不在场则本轮跳过。
  schedules: [
    {
      id: "session-index-vacuum",
      name: "会话索引库瘦身（回收删除残留空闲页，不删会话数据；长任务——经索引 worker 后台执行，主线程零阻塞）",
      intervalSec: 86400,
      enabled: true,
      run: (sctx: { configDir?: string }) => {
        const dir = sctx?.configDir || smConfigDir;
        if (!dir) return;
        const ok = requestIndexVacuum(join(dirname(dir), "cache", "index.sqlite"));
        if (!ok) console.warn("[session-manager] vacuum 触发失败：索引 worker 不在场（bundle 缺失或已禁用），本轮跳过");
      },
    },
  ],

  server: {
    api,

    /** startup: open the index, kick the first sync off in the background, start the auto-archive timer. */
    async startup(ctx) {
      smConfigDir = ctx.configDir || "";
      // 活动数据帧发布通道（总线缺席静默；帧构造/节流/行缓存见 server/activity-bus.ts）
      bindActivityPublisher((type, data) => {
        try {
          const bus = ctx.services?.get?.<{ publish?: (t: string, d?: Record<string, unknown>) => void }>("aiti-event-bus.publish");
          bus?.publish?.(type, data);
        } catch { /* 总线缺席静默 */ }
      });
      // 数据分层（config/state/cache）：归档包落 state/archive（archivePackagesDir，见 session-archive.ts）；
      // 存量迁移由部署流程的一次性脚本负责（scripts/migrate-state-tier.mjs），扩展不带运行时迁移。
      // extDir → 索引 worker bundle 定位（dist/index-worker.mjs；缺失时门面自动回落主线程）
      runtime(ctx.configDir, { extDir: (ctx as { dir?: string }).dir || "" }); // ensure dirs + open index
      // 跨扩展服务出口（DI 方案 P1）：ctx.services 通道（sessions/tags 惰性 getter，
      // 方法闭包引用模块变量，热重载/索引就绪均安全）；旧通道（__piWebExt.byId 穿透）
      // 双轨保留至消费方迁完。hotwords 仅 ai-helper 经 HTTP 聚合，不经 services。
      ctx.services?.provide?.("session-manager.sessions", ext.services.sessions);
      ctx.services?.provide?.("session-manager.tags", ext.services.tags);
      ctx.services?.provide?.("session-manager.hotwords", ext.services.hotwords); // aiti-ai-input 消费
      // 首次同步在全量会话场景下实测 ~4s（跨项目全量扫描）：不阻塞全局 startAll（每
      // 次扩展 reload 都会重跑），放后台执行，失败仅记日志。面板合并视图实时拉 live
      // 会话（api mergedSessionsEndpoint），索引侧数据（归档/标签）在同步完成后几秒内
      // 补齐——只影响本扩展自身功能的就绪速度，不影响其他扩展。
      void syncIndex(ctx.configDir, ctx.core).catch((e) =>
        console.error("[session-manager] background first sync failed:", e instanceof Error ? e.message : e));
      // 帮助点已声明在 ai.helpers，由 ai-helper 主动聚合，无需在此注册
      const settings = loadSettings(ctx.configDir);
      if (settings.autoArchive && settings.autoArchiveIntervalH > 0) {
        archiveTimer = setInterval(() => {
          void runArchive(ctx.configDir, ctx.core).catch((e) => console.error("[session-manager] auto archive failed:", e));
        }, settings.autoArchiveIntervalH * 3600 * 1000);
        // don't hold the process open
        if (archiveTimer.unref) archiveTimer.unref();
      }
    },

    async shutdown(ctx) {
      if (archiveTimer) {
        clearInterval(archiveTimer);
        archiveTimer = null;
      }
      try {
        runtime(ctx.configDir).index.close();
      } catch { /* already closed */ }
      // 活动广播清理：退订发布口 + 清行缓存/节流计时器（reload 后由新 startup 重注入）
      bindActivityPublisher(null);
      resetActivityBusState();
    },

    agent: {
      /** 会话消息落盘 → 广播 sm:session-activity（列表行实时刷新，见 publishSessionActivity）。
       *  ⚠ 可能被重复调用（idle GC → wrapper 重建 / 扩展 reload 重挂）——宿主订阅纪元
       *  账本先回收上一轮订阅，本实现无需自行退订（幂等）。 */
      onAgentSession(info?: {
        sessionId?: string;
        subscribeEvent?: (listener: (event: { type: string } & Record<string, unknown>) => void) => () => void;
      }) {
        const sid = typeof info?.sessionId === "string" ? info.sessionId : "";
        if (!sid || typeof info?.subscribeEvent !== "function") return;
        try {
          info.subscribeEvent((event) => {
            // message_end = 一条消息落盘（user/assistant/toolResult 均经此）——行数据
            // （messageCount/modified）此刻起对下一次列表扫描可见。流式增量
            // （message_update）刻意不触发：频率过高且行数据此刻尚未变化。
            if (event?.type !== "message_end") return;
            publishSessionActivity(sid, (event as { message?: unknown }).message);
          });
        } catch { /* subscribeEvent 不可用（旧宿主）→ 退化为 running 帧带动 */ }
      },
    },
  },

  ui: {
    /** 能力接管声明（契约：pi-web lib/ext/types.ts 的 EXT_PROVIDES）：
     *  会话删除由本扩展接管（先归档、再在归档记录上删除），
     *  core 侧栏据此隐藏内置删除按钮。 */
    provides: ["session-delete"],
    toolbar: [{ id: "sessions", label: "Sessions", title: "All sessions", icon: "icons/message-square.svg" }],
    sidebar: [{ id: "sessions", label: "Sessions", title: "All sessions", badge: true }],
    sidebarProjects: [{ id: "clone", label: "项目 / Projects", title: "左侧会话列表接管（SidebarClone）" }],
    // 左栏整块接管（sidebar 统一 dock 方案 §3.2）：AppShell 层 Header + DockStack + 底部行
    sidebarContent: [{ id: "master", label: "侧栏接管", title: "左侧栏整块接管（SidebarContentDock）" }],
    sessionTopbar: [{ id: "tags", label: "tags" }],
    sessionRowMeta: [{ id: "session-tags", label: "会话标签" }],
    sessionRowActions: [{ id: "star", label: "star", title: "Favorite" }],
    workspacePickerActions: [{ id: "manage", label: "Manage workspaces" }],
    // 新建会话「分支 / Worktree」选择器（欢迎页 Workspace×Backend 之间；方案
    // docs/pi-web-new-session-branch-worktree-plan.md）：渲染插槽 + preparer 注册面成对声明。
    // 旧宿主不认识这两个插槽键 → 仅多两个无人消费的声明，无害（版本错配降级）。
    newSessionSelectors: [{ id: "picker", label: "分支 / Worktree" }],
    newSessionPreparers: [{ id: "picker", label: "分支 / Worktree preparer" }],
    dialogs: [{ id: "panel", label: "All sessions" }, { id: "tags-manager", label: "Tag manager" }, { id: "tag-popover", label: "Tag popover" }],
    banners: [],
    pages: [],
    i18n: {
      en: {
        "sidebar.loading": "Loading...",
        "sidebar.noSessions": "No sessions found",
        "sidebar.new": "New",
        "sidebar.newSessionTitle": "New session in {path}",
        "sidebar.refresh": "Refresh",
        "sidebar.hide": "Hide sidebar",
        "sidebar.toggleSessionSearch": "Search conversations",
        "sidebar.searchSessions": "Search all conversations...",
        "sidebar.filterProjects": "Filter projects…",
        "sidebar.noMatchingProjects": "No matching projects",
        "sidebar.useDefaultDirectory": "Use default directory",
        "sidebar.customPath": "Custom path…",
        "sidebar.newActivity": "New activity",
        "sidebar.newSessionActivity": "New session activity",
        "sidebar.agentRunning": "Agent running…",
        "sidebar.messagesCount": "{count} msgs",
        "sidebar.draft": "Draft",
        "sidebar.draftTitle": "Not saved yet — appears once the agent replies",
        "sidebar.rename": "Rename",
        "sidebar.delete": "Delete",
        "sidebar.cancel": "Cancel",
        "sidebar.deleteSession": "Delete {title}?",
        "sidebar.deleteWithShiftClick": "Delete (Shift+click to delete without confirmation)",
        "sidebar.expandSubagents": "Expand sub-sessions",
        "sidebar.collapseSubagents": "Collapse sub-sessions",
        "sidebar.expandBranches": "Expand branch sessions",
        "sidebar.collapseBranches": "Collapse branch sessions",
        "sidebar.openRepoRoot": "Open repo root",
        "sidebar.openRepoRootTitle": "Open the repository root to manage worktrees.",
        "sidebar.gitRepoRootOnly": "Git repo root only",
        "sidebar.gitRepoRootOnlyTitle": "Worktrees are available in Git repository roots.",
        "sidebar.checkingWorktrees": "Checking worktrees for this directory.",
        "sidebar.worktrees": "Worktrees...",
        "sidebar.switchWorktree": "Switch worktree",
        "sidebar.switchWorktreeTitle": "Switch worktree: {path}",
        "sidebar.main": "main",
        "sidebar.filterWorktrees": "Filter worktrees…",
        "sidebar.noMatchingWorktrees": "No matching worktrees",
        "sidebar.forceRemoveCheckout": "Uncommitted changes. Force remove checkout?",
        "sidebar.force": "Force",
        "sidebar.removeWorktreeTitle": "Remove worktree checkout {path}; the branch is kept",
        "sidebar.createWorktreeTitle": "Create a worktree checkout for a branch",
        "sidebar.newWorktree": "New worktree…",
        "sidebar.branchName": "branch name",
        "sidebar.creating": "Creating…",
        "sidebar.create": "Create",
        "sidebar.selectProject": "Select project…",
        "sidebar.sessionSearching": "Searching...",
        "sidebar.sessionSearchFailed": "Could not search conversations",
        "sidebar.sessionSearchEmpty": "No matching conversations",
        "sidebar.sessionSearchCount": "{count} matching conversations",
        "sidebar.sessionSearchPartial": "Search limit reached. Results may be incomplete.",
        "directoryPicker.selectDirectory": "Select directory",
        "directoryPicker.goToParent": "Go to parent directory",
        "directoryPicker.directoryPath": "Directory path",
        "directoryPicker.goToDirectory": "Go to directory",
        "directoryPicker.go": "Go",
        "directoryPicker.loadingDirectories": "Loading directories…",
        "directoryPicker.noDrives": "No drives found",
        "directoryPicker.noSubdirectories": "No subdirectories",
        "directoryPicker.openBeforeSelecting": "Open this path before selecting it",
        "directoryPicker.selectCurrentDirectory": "Select current directory",
        "directoryPicker.selectThisFolder": "Select this folder",
        "directoryPicker.newFolder": "New folder",
        "directoryPicker.newFolderIn": "Create a new folder in {path}",
        "directoryPicker.folderName": "Folder name",
        "i18n.close": "Close",
        "i18n.cancel": "Cancel",
        "i18n.checking": "Checking…",
        "sm.allSessions": "All sessions",
        "sm.dockProjects": "Projects",
        "sm.dockAddFolder": "Add folder to sidebar",
        "sm.searchPlaceholder": "Search sessions…",
        "sm.search": "Search",
        "sm.favorites": "Favorites",
        "sm.running": "Running",
        "sm.runFailed": "Task failed",
        "sm.runAborted": "Stopped",
        "sm.runInterrupted": "Interrupted (did not finish)",
        "sm.runFailedWithError": "Task failed: {error}",
        "sm.runningSessions": "Running sessions",
        "sm.noRunning": "No running sessions",
        "sm.recent": "Recently completed",
        "sm.openAll": "Open all sessions",
        "sm.noSessions": "No sessions yet",
        "sm.noResults": "No matching sessions",
        "sm.loading": "…",
        "sm.loadMore": "Load more (+{n})",
        "sm.favorite": "Favorite",
        "sm.unfavorite": "Unfavorite",
        "sm.addTag": "Add tag…",
        "sm.tagPlaceholder": "tag, another/tag",
        "sm.manageTags": "Manage tags…",
        "sm.pageOf": "{page} / {pages}",
        "sm.prev": "Prev",
        "sm.next": "Next",
        "sm.allTags": "All",
        "sm.session": "Session: {id}",
        "sm.noSession": "New session",
        "sm.tags": "Tags",
        "sm.newTag": "New tag",
        "sm.newChild": "Add child",
        "sm.rename": "Rename",
        "sm.autoName": "Generate name",
        "sm.autoNameFailed": "Auto-name failed",
        "sm.autoNameBridged": "This session is owned by a terminal (TUI); auto name generation is unavailable while the terminal holds it. Please rename it manually.",
        "sm.move": "Move to…",
        "sm.moveTitle": "Move session",
        "sm.moveTarget": "Target directory (cwd)",
        "sm.moveHint": "Rewrites the session's cwd and relocates its file into the target project. History, favorites and tags are kept; the session id stays the same.",
        "sm.moveConfirm": "Move",
        "sm.detectCwd": "Detecting this session's real project directory…",
        "sm.detectFiles": "{n} files touched",
        "sm.detect": "Detected",
        "sm.cur": "cur",
        "sm.moveBatch": "Move selected to…",
        "sm.moveBatchDefault": "Default target directory (cwd)",
        "sm.moveBatchHint": "Set a default target; each row can override it individually. Running sessions are skipped.",
        "sm.moveBatchDone": "Moved {count} session(s)",
        "sm.moveBatchSkip": "{n} session(s) not movable (external agent / archived) skipped",
        "sm.moveFailed": "Move failed",
        "sm.manageWorkspaces": "Manage workspaces",
        "sm.manageWorkspacesTitle": "Manage workspace list — select, hide, or delete a workspace",
        "sm.manageWorkspacesHint": "Select a workspace to open it. Hide removes it from the sidebar dropdown (sessions are kept). Delete asks how to handle its sessions: move all to a new directory, or archive them.",
        "sm.manageNoWorkspaces": "No workspaces yet",
        "sm.manageHidden": "hidden",
        "sm.manageSelect": "Select",
        "sm.manageHide": "Hide",
        "sm.manageShow": "Show",
        "sm.manageDelete": "Delete",
        "sm.manageDeleteTitle": "Delete workspace",
        "sm.manageDeleteCount": "{count} live sessions in this workspace",
        "sm.manageMoveAll": "Move all sessions to a new directory",
        "sm.manageMoveAllHint": "Rewrites each session's cwd and relocates its file; running sessions are skipped.",
        "sm.manageArchiveAll": "Archive all sessions",
        "sm.manageArchiveAllHint": "Pack sessions into an archive (recoverable); running sessions are skipped.",
        "sm.manageMoved": "Moved {moved} session(s); skipped {skipped} (running / not movable).",
        "sm.manageMoveFailed": "Move failed",
        "sm.manageArchived": "Archived {archived} session(s).",
        "sm.manageArchiveFailed": "Archive failed",
        "sm.more": "More actions",
        "sm.pin": "Pin to top",
        "sm.unpin": "Unpin",
        "sm.pinned": "Pinned to top",
        "sm.pinProject": "Pin project",
        "sm.unpinProject": "Unpin project",
        "sm.projectPinUp": "Move up among pinned projects",
        "sm.projectPinDown": "Move down among pinned projects",
        "sm.delete": "Delete",
        "sm.deleteSubtree": "Delete subtree",
        "sm.recolor": "Color",
        "sm.resetColor": "Reset color",
        "sm.confirmDelete": "Delete this tag?",
        "sm.confirmDeleteSubtree": "Delete this tag and all children?",
        "sm.close": "Close",
        "sm.empty": "No sessions",
        "sm.runningCount": "{count} running",
        "sm.msgCount": "{count} msgs",
        "sm.archived": "Archived",
        "sm.archivedHidden": "{count} archived sessions hidden — click to show",
        "sm.clearCache": "Clear archive cache",
        "sm.chooseTag": "Choose a tag",
        "sm.kanban": "Kanban",
        "sm.allProjects": "All projects",
        "sm.columns": "Columns:",
        "sm.filter": "Filter",
        "sm.noColumns": "No columns yet — pick tags above (or create tags in the panel)",
        "sm.stats": "Stats",
        "sm.model": "Model",
        "sm.date": "Date",
        "sm.dir": "Directory",
        "sm.dir.all": "All dirs",
        "sm.dir.pick": "Choose directory…",
        "sm.dir.change": "Change directory…",
        // 跨扩展内联的 aiti-folder DirectoryBrowser/WorkspaceDropdown 所用 key（ctx.t 只读本表，缺则显裸 key）
        "sidebar.customPath": "Custom path…",
        "sidebar.filterProjects": "Filter projects…",
        "sidebar.noMatchingProjects": "No matching projects",
        "sidebar.agentRunning": "Agent running…",
        "sidebar.newSessionActivity": "New session activity",
        "i18n.close": "Close",
        "files.parentDir": "Parent directory",
        "files.loading": "Loading files...",
        "files.noSubdirs": "No subdirectories",
        "files.selectFolder": "Select this folder",
        "files.cancel": "Cancel",
        "sm.sort": "Sort",
        "sm.roleSearch": "Role (search)",
        "sm.clearAll": "Clear all",
        "sm.selectedCount": "{count} selected",
        "sm.archive": "Archive",
        "sm.archiveDialogTitle": "Archive session",
        "sm.archiveResolved": "Archive as resolved",
        "sm.archiveUnresolved": "Archive as unresolved",
        "sm.archiveDirect": "Archive directly",
        "sm.archiveDelete": "Delete permanently",
        "sm.archiveTagResolved": "resolved",
        "sm.archiveTagUnresolved": "unresolved",
        "sm.delete": "Delete",
        "sm.deleteArchive": "Delete permanently",
        "sm.deleteLive": "Delete permanently (live session)",
        "sm.confirmDeleteLive": "Permanently delete this LIVE session file? (not archived — bypasses archive, cannot be undone; running agents are stopped first)",
        "sm.extRemove": "Remove from list",
        "sm.extTrueArchive": "True archive (remove from source, restorable)",
        "sm.pendingRemoval": "Removing…",
        "sm.extRemoveTitle": "Move to the archived group; hidden from the list. Recoverable anytime — data inside ZCode/Cursor etc. is not touched.",
        "sm.extChildrenTogetherBtn": "Remove the {count} children too",
        "sm.extChildrenKeepBtn": "Remove the main session only",
        "sm.extHintTogether": "together with the main session (hidden from list)",
        "sm.extHintKeep": "children stay in the list",
        "sm.extFlatTogether": "Remove from list (with {count} children)",
        "sm.extFlatKeep": "Remove from list (self only)",
        "sm.deleteFailed": "Delete failed",
        "sm.deleteTitle": "Delete permanently",
        "sm.confirmTitle": "Confirm",
        "sm.gotIt": "Got it",
        "sm.confirmOk": "OK",
        "sm.batchDeleteTitle": "Batch delete",
        "sm.batchDeleteMsg": "Permanently delete {count} unarchived sessions? Cannot be undone; running agents are stopped first.",
        "sm.noLiveToDelete": "No unarchived sessions to delete (use the row's ⋮ menu for archived ones)",
        "sm.batchDeleteFailed": "{count} session(s) failed to delete",
        "sm.batchDeleteSkipped": "Skipped {count} archived session(s) (delete archive records from the archived rows)",
        "sm.childrenTogetherBtnArchive": "Archive the {count} children too",
        "sm.childrenTogetherBtnDelete": "Delete the {count} children too",
        "sm.childrenHintTogether": "together with the main session (children first)",
        "sm.childrenKeepBtnArchive": "Archive the main session only",
        "sm.childrenKeepBtnDelete": "Delete the main session only",
        "sm.childrenHintKeepArchive": "children stay live",
        "sm.childrenHintKeepDelete": "children re-parent to the level above",
        "sm.restore": "Restore to live sessions",
        "sm.restoreShort": "Restore",
        "sm.reopen": "Reopen (restore & open)",
        "sm.reopenShort": "Reopen",
        "sm.restoreFailed": "Restore failed",
        "sm.reopenFailed": "Reopen failed",
        "sm.relatedDocs": "Related docs",
        "sm.relatedDocsShort": "Docs",
        "sm.timeline": "Timeline",
        "sm.relatedDocsEmpty": "No docs were touched by this session",
        "sm.relatedDocsHint": "Docs the session touched · collected by aiti-git-trace, related via aiti-doc-center",
        "sm.docCenterAbsent": "Doc center not enabled (aiti-doc-center)",
        "sm.confirmDeleteArchive": "Permanently delete this ARCHIVED session? (archive first, then delete — cannot be undone)",
        "sm.confirmDeleteArchiveN": "Permanently delete {count} archived sessions? Cannot be undone.",
        "sm.clear": "Clear",
        "sm.msgCountLabel": "Messages",
        "sm.modelDist": "Models",
        "sm.activityHint": "Activity (click a day to filter)",
        "sm.todayLine": "Today +{s} sessions · +{m} msgs",
        "sm.weekLine": "7d {n} msgs",
        "sm.sessions": "Sessions",
        "sm.today": "Today",
        "sm.last24h": "24h",
        "sm.last2d": "2 days",
        "sm.last7d": "7 days",
        "sm.last30d": "30 days",
        "sm.sourcesLabel": "Sources",
        "sm.sources.found": "Found {count} · ",
        "sm.sources.load": "Load",
        "sm.sources.loading": "…",
        "sm.sources.loaded": "Loaded",
        "sm.sources.sync": "Sync",
        "sm.sources.stale": "⟳ Update",
        "sm.sources.staleHint": "New sessions detected — sync in the source strip below.",
        "sm.sources.uninstalled": "Not installed",
        "sm.sources.error": "Error",
        "sm.import.button": "⬇ Import as pi session",
        "sm.import.failed": "Import failed: external session has no cwd, or the pi sessions dir is not writable.",
        "sm.viewerSearch": "Search messages…",
        "sm.viewerNoMatch": "No matching messages",
        // 查看器聊天式消息区（docs/session-manager-viewer-chat-plan.md §3.5）
        "sm.viewer.user": "User",
        "sm.viewer.assistant": "Assistant",
        "sm.viewer.toolResult": "Tool result",
        "sm.viewer.input": "Input",
        "sm.viewer.output": "Output",
        "sm.viewer.lines": "{n} lines",
        "sm.viewer.expandAll": "Show all ({n} chars)",
        "sm.viewer.collapse": "Collapse",
        "sm.viewer.copy": "Copy",
        "sm.viewer.copied": "Copied",
        "sm.viewer.toTop": "Jump to top",
        "sm.viewer.toBottom": "Jump to latest",
        "sm.viewer.filterUser": "Show / hide user messages",
        "sm.viewer.filterAssistant": "Show / hide assistant messages",
        "sm.viewer.filterTool": "Show / hide tool results",
        "sm.viewer.stats": "{total} shown · {user} user · {assistant} assistant · {tool} tool",
        "sm.viewer.openImage": "click to open",
        "sm.viewer.truncated": "… {n} more lines not shown",
        "sm.viewer.extSession": "External session",
        "sm.agentFilter.empty": "No source selected — pick agents from the chips above.",
        "sm.dockAdv": "Adv",
        "sm.dockAdvTitle": "Advanced filters (agents / tags)",
        "sm.dockAdvAgents": "Agents",
        "sm.dockAdvTags": "Tags",
        "sm.tagDocs": "{count} related docs",
        "sm.tagDocsTip": "Documents carrying this tag (from aiti-doc-center; includes subtree tags)",
        "sm.dockAdvDoc": "Docs",
        "sm.dockAdvDocPick": "Pick doc…",
        "sm.dockAdvDocEmpty": "No docs (doc-center not ready or nothing indexed)",
        "sm.dockAdvDocCount": "{count} sessions touched",
        "sm.cloudsCollapsed": "Tags / sources collapsed",
        "sm.expanded": "Expanded",
        "sm.scrollToCollapse": "scroll down to collapse again",
        "sm.expand": "Expand",
        "sm.collapse": "Collapse",
      },
      "zh-TW": {
        "sidebar.loading": "載入中...",
        "sidebar.noSessions": "找不到工作階段",
        "sidebar.new": "新增",
        "sidebar.newSessionTitle": "在 {path} 中新增工作階段",
        "sidebar.refresh": "重新整理",
        "sidebar.hide": "隱藏側邊欄",
        "sidebar.toggleSessionSearch": "搜尋對話",
        "sm.dockProjects": "專案",
        "sm.runFailed": "任務失敗",
        "sm.runAborted": "已停止",
        "sm.runInterrupted": "已中斷（未正常結束）",
        "sm.runFailedWithError": "任務失敗：{error}",
        "sm.dockAddFolder": "加入資料夾到側欄",
        "sidebar.searchSessions": "搜尋所有對話...",
        "sidebar.filterProjects": "篩選專案…",
        "sidebar.noMatchingProjects": "找不到相符的專案",
        "sidebar.useDefaultDirectory": "使用預設目錄",
        "sidebar.customPath": "自訂路徑…",
        "sidebar.newActivity": "有新活動",
        "sidebar.newSessionActivity": "工作階段有新活動",
        "sidebar.agentRunning": "Agent 執行中…",
        "sidebar.messagesCount": "{count} 則訊息",
        "sidebar.draft": "草稿",
        "sidebar.draftTitle": "尚未保存——agent 回复后正式写入",
        "sidebar.rename": "重新命名",
        "sidebar.delete": "刪除",
        "sidebar.cancel": "取消",
        "sidebar.deleteSession": "刪除 {title}？",
        "sidebar.deleteWithShiftClick": "刪除（按住 Shift 點選可跳過確認）",
        "sidebar.expandSubagents": "展開子會話",
        "sidebar.collapseSubagents": "摺疊子會話",
        "sidebar.expandBranches": "展開分支會話",
        "sidebar.collapseBranches": "摺疊分支會話",
        "sidebar.openRepoRoot": "開啟儲存庫根目錄",
        "sidebar.openRepoRootTitle": "開啟儲存庫根目錄以管理 worktree。",
        "sidebar.gitRepoRootOnly": "僅限 Git 儲存庫根目錄",
        "sidebar.gitRepoRootOnlyTitle": "worktree 只能在 Git 儲存庫根目錄使用。",
        "sidebar.checkingWorktrees": "正在檢查此目錄的 worktree。",
        "sidebar.worktrees": "Worktrees...",
        "sidebar.switchWorktree": "切換 worktree",
        "sidebar.switchWorktreeTitle": "切換 worktree：{path}",
        "sidebar.main": "主分支",
        "sidebar.filterWorktrees": "篩選 worktree…",
        "sidebar.noMatchingWorktrees": "找不到相符的 worktree",
        "sidebar.forceRemoveCheckout": "有未提交的變更。要強制移除 checkout 嗎？",
        "sidebar.force": "強制移除",
        "sidebar.removeWorktreeTitle": "移除 worktree checkout {path}；保留分支",
        "sidebar.createWorktreeTitle": "為分支建立 worktree checkout",
        "sidebar.newWorktree": "新增 worktree…",
        "sidebar.branchName": "分支名稱",
        "sidebar.creating": "建立中…",
        "sidebar.create": "建立",
        "sidebar.selectProject": "選擇專案…",
        "sidebar.sessionSearching": "搜尋中...",
        "sidebar.sessionSearchFailed": "無法搜尋對話",
        "sidebar.sessionSearchEmpty": "找不到相符的對話",
        "sidebar.sessionSearchCount": "{count} 個相符的對話",
        "sidebar.sessionSearchPartial": "已達搜尋上限，結果可能不完整。",
        "directoryPicker.selectDirectory": "選擇目錄",
        "directoryPicker.goToParent": "前往上一層目錄",
        "directoryPicker.directoryPath": "目錄路徑",
        "directoryPicker.goToDirectory": "前往目錄",
        "directoryPicker.go": "前往",
        "directoryPicker.loadingDirectories": "正在載入目錄…",
        "directoryPicker.noDrives": "找不到磁碟機代號",
        "directoryPicker.noSubdirectories": "沒有子目錄",
        "directoryPicker.openBeforeSelecting": "選擇前請先開啟此路徑",
        "directoryPicker.selectCurrentDirectory": "選擇目前目錄",
        "directoryPicker.selectThisFolder": "選擇此資料夾",
        "directoryPicker.newFolder": "新增資料夾",
        "directoryPicker.newFolderIn": "在 {path} 下新增資料夾",
        "directoryPicker.folderName": "資料夾名稱",
        "i18n.close": "關閉",
        "i18n.cancel": "取消",
        "i18n.checking": "檢查中…",
        "sm.extRemove": "從列表移除",
        "sm.extTrueArchive": "真歸檔（從來源移除，可放回）",
        "sm.pin": "置頂",
        "sm.unpin": "取消置頂",
        "sm.pinned": "已置頂",
        "sm.pinProject": "釘住專案",
        "sm.unpinProject": "取消釘住專案",
        "sm.projectPinUp": "在釘住項中上移",
        "sm.projectPinDown": "在釘住項中下移",
        "sm.pendingRemoval": "處理中…",
        "sm.extRemoveTitle": "收進已封存分組，列表不再顯示；隨時可恢復接管，ZCode 等應用內資料不受影響。",
        "sm.extChildrenTogetherBtn": "同時移除 {count} 個子會話",
        "sm.extChildrenKeepBtn": "只移除主會話",
        "sm.extHintTogether": "連同主會話一起移出列表（先子後主）",
        "sm.extHintKeep": "子會話保留在列表",
        "sm.extFlatTogether": "從列表移除（連同 {count} 個子會話）",
        "sm.extFlatKeep": "從列表移除（僅自己）",
        // 查看器聊天式消息區（docs/session-manager-viewer-chat-plan.md §3.5）
        "sm.msgCount": "{count} 則訊息",
        "sm.viewerSearch": "搜尋訊息…",
        "sm.viewerNoMatch": "沒有相符的訊息",
        "sm.viewer.user": "使用者",
        "sm.viewer.assistant": "助手",
        "sm.viewer.toolResult": "工具結果",
        "sm.viewer.input": "輸入",
        "sm.viewer.output": "輸出",
        "sm.viewer.lines": "{n} 行",
        "sm.viewer.expandAll": "展開全部（{n} 字）",
        "sm.viewer.collapse": "收起",
        "sm.viewer.copy": "複製",
        "sm.viewer.copied": "已複製",
        "sm.viewer.toTop": "回到頂部",
        "sm.viewer.toBottom": "跳到最新",
        "sm.viewer.filterUser": "顯示 / 隱藏使用者訊息",
        "sm.viewer.filterAssistant": "顯示 / 隱藏助手訊息",
        "sm.viewer.filterTool": "顯示 / 隱藏工具結果",
        "sm.viewer.stats": "顯示 {total} 則 · 使用者 {user} · 助手 {assistant} · 工具 {tool}",
        "sm.viewer.openImage": "點擊開啟",
        "sm.viewer.truncated": "… 其餘 {n} 行未顯示",
        "sm.viewer.extSession": "外部會話",
      },
      "zh-CN": {
        "sidebar.loading": "加载中...",
        "sidebar.noSessions": "未找到会话",
        "sidebar.new": "新建",
        "sidebar.newSessionTitle": "在 {path} 中新建会话",
        "sidebar.refresh": "刷新",
        "sidebar.hide": "隐藏侧边栏",
        "sidebar.toggleSessionSearch": "搜索对话",
        "sidebar.searchSessions": "搜索所有对话...",
        "sidebar.filterProjects": "筛选项目…",
        "sidebar.noMatchingProjects": "没有匹配的项目",
        "sidebar.useDefaultDirectory": "使用默认目录",
        "sidebar.customPath": "自定义路径…",
        "sidebar.newActivity": "有新活动",
        "sidebar.newSessionActivity": "会话有新活动",
        "sidebar.agentRunning": "Agent 运行中…",
        "sidebar.messagesCount": "{count} 条消息",
        "sidebar.draft": "草稿",
        "sidebar.draftTitle": "尚未保存——agent 回复后正式写入",
        "sidebar.rename": "重命名",
        "sidebar.delete": "删除",
        "sidebar.cancel": "取消",
        "sidebar.deleteSession": "删除 {title}？",
        "sidebar.deleteWithShiftClick": "删除（Shift+点击可直接删除，不确认）",
        "sidebar.expandSubagents": "展开子会话",
        "sidebar.collapseSubagents": "折叠子会话",
        "sidebar.expandBranches": "展开分支会话",
        "sidebar.collapseBranches": "折叠分支会话",
        "sidebar.openRepoRoot": "打开仓库根目录",
        "sidebar.openRepoRootTitle": "打开仓库根目录以管理 worktree。",
        "sidebar.gitRepoRootOnly": "仅 Git 仓库根目录",
        "sidebar.gitRepoRootOnlyTitle": "只能在 Git 仓库根目录使用 worktree。",
        "sidebar.checkingWorktrees": "正在检查此目录的 worktree。",
        "sidebar.worktrees": "Worktrees...",
        "sidebar.switchWorktree": "切换 worktree",
        "sidebar.switchWorktreeTitle": "切换 worktree：{path}",
        "sidebar.main": "主分支",
        "sidebar.filterWorktrees": "筛选 worktree…",
        "sidebar.noMatchingWorktrees": "没有匹配的 worktree",
        "sidebar.forceRemoveCheckout": "存在未提交的更改。强制移除 checkout？",
        "sidebar.force": "强制移除",
        "sidebar.removeWorktreeTitle": "移除 worktree checkout {path}；保留分支",
        "sidebar.createWorktreeTitle": "为分支创建 worktree checkout",
        "sidebar.newWorktree": "新建 worktree…",
        "sidebar.branchName": "分支名称",
        "sidebar.creating": "创建中…",
        "sidebar.create": "创建",
        "sidebar.selectProject": "选择项目…",
        "sidebar.sessionSearching": "搜索中...",
        "sidebar.sessionSearchFailed": "无法搜索对话",
        "sidebar.sessionSearchEmpty": "没有匹配的对话",
        "sidebar.sessionSearchCount": "{count} 个匹配的对话",
        "sidebar.sessionSearchPartial": "已达到搜索上限，结果可能不完整。",
        "directoryPicker.selectDirectory": "选择目录",
        "directoryPicker.goToParent": "转到上级目录",
        "directoryPicker.directoryPath": "目录路径",
        "directoryPicker.goToDirectory": "转到目录",
        "directoryPicker.go": "转到",
        "directoryPicker.loadingDirectories": "正在加载目录…",
        "directoryPicker.noDrives": "未找到盘符",
        "directoryPicker.noSubdirectories": "没有子目录",
        "directoryPicker.openBeforeSelecting": "选择前请先打开此路径",
        "directoryPicker.selectCurrentDirectory": "选择当前目录",
        "directoryPicker.selectThisFolder": "选择此文件夹",
        "directoryPicker.newFolder": "新建文件夹",
        "directoryPicker.newFolderIn": "在 {path} 下新建文件夹",
        "directoryPicker.folderName": "文件夹名称",
        "i18n.close": "关闭",
        "i18n.cancel": "取消",
        "i18n.checking": "检查中…",
        "sm.allSessions": "全部会话",
        "sm.dockProjects": "项目",
        "sm.dockAddFolder": "添加文件夹到侧栏",
        "sm.searchPlaceholder": "搜索会话…",
        "sm.search": "搜索",
        "sm.favorites": "收藏",
        "sm.running": "运行中",
        "sm.runFailed": "任务失败",
        "sm.runAborted": "已停止",
        "sm.runInterrupted": "已中断（未正常结束）",
        "sm.runFailedWithError": "任务失败：{error}",
        "sm.runningSessions": "运行中的会话",
        "sm.noRunning": "暂无运行中的会话",
        "sm.recent": "最近完成",
        "sm.openAll": "打开全部会话",
        "sm.noSessions": "暂无会话",
        "sm.noResults": "没有匹配的会话",
        "sm.loading": "…",
        "sm.loadMore": "加载更多 (+{n})",
        "sm.favorite": "收藏",
        "sm.unfavorite": "取消收藏",
        "sm.addTag": "添加标签…",
        "sm.tagPlaceholder": "标签, 分类/子标签",
        "sm.manageTags": "管理标签…",
        "sm.pageOf": "{page} / {pages}",
        "sm.prev": "上一页",
        "sm.next": "下一页",
        "sm.allTags": "全部",
        "sm.session": "会话：{id}",
        "sm.noSession": "新建会话",
        "sm.tags": "标签",
        "sm.newTag": "新建标签",
        "sm.newChild": "添加子标签",
        "sm.rename": "重命名",
        "sm.autoName": "生成名字",
        "sm.autoNameFailed": "生成名字失败",
        "sm.autoNameBridged": "该会话正由终端（TUI）占用，无法自动生成名字，请手动命名。",
        "sm.move": "移动到…",
        "sm.moveTitle": "移动会话",
        "sm.moveTarget": "目标目录（cwd）",
        "sm.moveHint": "改写会话的 cwd 并把会话文件移入目标项目；历史、收藏、标签全部保留，sessionId 不变。运行中的会话需等结束后再移。",
        "sm.moveConfirm": "移动",
        "sm.detectCwd": "识别该会话的真实项目目录…",
        "sm.detectFiles": "触达 {n} 个文件",
        "sm.detect": "检测",
        "sm.cur": "当前",
        "sm.moveBatch": "批量移动到…",
        "sm.moveBatchDefault": "默认目标位置（cwd）",
        "sm.moveBatchHint": "设置默认目标位置；每行可单独改目标覆盖默认值。运行中的会话会被跳过。",
        "sm.moveBatchDone": "已移动 {count} 个会话",
        "sm.moveBatchSkip": "{n} 个会话不可移动（外部 agent/归档）已跳过",
        "sm.moveFailed": "移动失败",
        "sm.manageWorkspaces": "管理工作区",
        "sm.manageWorkspacesTitle": "管理工作区列表——选择 / 隐藏 / 删除",
        "sm.manageWorkspacesHint": "选择项目直接打开。隐藏把它从侧边栏下拉里移除（会话保留）。删除需先选择处置方式：把全部会话移动到新目录，或全部归档。",
        "sm.manageNoWorkspaces": "还没有工作区",
        "sm.manageHidden": "已隐藏",
        "sm.manageSelect": "选择",
        "sm.manageHide": "隐藏",
        "sm.manageShow": "显示",
        "sm.manageDelete": "删除",
        "sm.manageDeleteTitle": "删除工作区",
        "sm.manageDeleteCount": "该工作区有 {count} 个 live 会话",
        "sm.manageMoveAll": "把全部会话移动到新目录",
        "sm.manageMoveAllHint": "逐会话改写 cwd 并搬移文件；运行中的会话跳过。",
        "sm.manageArchiveAll": "归档全部会话",
        "sm.manageArchiveAllHint": "打包进归档（可恢复）；运行中的会话跳过。",
        "sm.manageMoved": "已移动 {moved} 个会话；跳过 {skipped} 个（运行中/不可移动）。",
        "sm.manageMoveFailed": "移动失败",
        "sm.manageArchived": "已归档 {archived} 个会话。",
        "sm.manageArchiveFailed": "归档失败",
        "sm.more": "更多操作",
        "sm.pin": "置顶",
        "sm.unpin": "取消置顶",
        "sm.pinned": "已置顶",
        "sm.pinProject": "钉住项目",
        "sm.unpinProject": "取消钉住项目",
        "sm.projectPinUp": "在钉住项中上移",
        "sm.projectPinDown": "在钉住项中下移",
        "sm.delete": "删除",
        "sm.deleteSubtree": "删除子树",
        "sm.recolor": "颜色",
        "sm.resetColor": "恢复默认色",
        "sm.confirmDelete": "删除该标签？",
        "sm.confirmDeleteSubtree": "删除该标签及其子标签？",
        "sm.close": "关闭",
        "sm.empty": "暂无会话",
        "sm.runningCount": "{count} 个运行中",
        "sm.msgCount": "{count} 条消息",
        "sm.archived": "已归档",
        "sm.archivedHidden": "已隐藏 {count} 个已归档会话，点击查看",
        "sm.clearCache": "清理归档缓存",
        "sm.chooseTag": "选择标签",
        "sm.kanban": "看板",
        "sm.allProjects": "全部项目",
        "sm.columns": "列：",
        "sm.filter": "过滤",
        "sm.noColumns": "还没有列——点击上方标签添加列（或先在面板里创建标签）",
        "sm.stats": "统计",
        "sm.model": "模型",
        "sm.date": "日期",
        "sm.dir": "目录",
        "sm.dir.all": "全部目录",
        "sm.dir.pick": "选择目录…",
        "sm.dir.change": "更换目录…",
        // 跨扩展内联的 aiti-folder DirectoryBrowser/WorkspaceDropdown 所用 key（与 aiti-folder i18n 对齐）
        "sidebar.customPath": "自定义路径…",
        "sidebar.filterProjects": "筛选项目…",
        "sidebar.noMatchingProjects": "没有匹配的项目",
        "sidebar.agentRunning": "Agent 运行中…",
        "sidebar.newSessionActivity": "新会话动态",
        "i18n.close": "关闭",
        "files.parentDir": "上级目录",
        "files.loading": "正在加载文件...",
        "files.noSubdirs": "无子目录",
        "files.selectFolder": "选择此文件夹",
        "files.cancel": "取消",
        "sm.sort": "排序",
        "sm.roleSearch": "角色（搜索）",
        "sm.clearAll": "清除全部",
        "sm.selectedCount": "已选 {count} 个",
        "sm.archive": "归档",
        "sm.archiveDialogTitle": "归档会话",
        "sm.archiveResolved": "已解决归档",
        "sm.archiveUnresolved": "未解决归档",
        "sm.archiveDirect": "直接归档",
        "sm.archiveDelete": "彻底删除",
        "sm.archiveTagResolved": "已解决",
        "sm.archiveTagUnresolved": "未解决",
        "sm.delete": "删除",
        "sm.deleteArchive": "彻底删除",
        "sm.deleteLive": "彻底删除（未归档）",
        "sm.confirmDeleteLive": "彻底删除该会话文件？（未归档，不经过归档直接删除，删后不可恢复；运行中的 agent 会先停止）",
        "sm.extRemove": "从列表移除",
        "sm.extTrueArchive": "真归档（从源移除，可放回）",
        "sm.pendingRemoval": "处理中…",
        "sm.extRemoveTitle": "收进已归档分组，列表不再显示；随时可恢复接管，ZCode 等应用内数据不受影响。",
        "sm.extChildrenTogetherBtn": "同时移除 {count} 个子会话",
        "sm.extChildrenKeepBtn": "只移除主会话",
        "sm.extHintTogether": "连同主会话一起移出列表（先子后主）",
        "sm.extHintKeep": "子会话保留在列表",
        "sm.extFlatTogether": "从列表移除（连同 {count} 个子会话）",
        "sm.extFlatKeep": "从列表移除（仅自己）",
        "sm.deleteFailed": "删除失败",
        "sm.deleteTitle": "彻底删除",
        "sm.confirmTitle": "确认操作",
        "sm.gotIt": "知道了",
        "sm.confirmOk": "确认",
        "sm.batchDeleteTitle": "批量删除",
        "sm.batchDeleteMsg": "永久删除 {count} 个未归档会话，不可恢复；运行中会先停止。确定继续？",
        "sm.noLiveToDelete": "没有未归档的会话可删除（已归档会话请到已归档行删除）",
        "sm.batchDeleteFailed": "{count} 个删除失败",
        "sm.batchDeleteSkipped": "跳过 {count} 个已归档会话（归档记录删除请到已归档行操作）",
        "sm.childrenTogetherBtnArchive": "同时归档 {count} 个子会话",
        "sm.childrenTogetherBtnDelete": "同时删除 {count} 个子会话",
        "sm.childrenHintTogether": "连同主会话，先子后主",
        "sm.childrenKeepBtnArchive": "只归档主会话",
        "sm.childrenKeepBtnDelete": "只删除主会话",
        "sm.childrenHintKeepArchive": "子会话保留",
        "sm.childrenHintKeepDelete": "子会话重挂上层",
        "sm.restore": "恢复为普通会话",
        "sm.restoreShort": "恢复",
        "sm.reopen": "重开（恢复并打开）",
        "sm.reopenShort": "重开",
        "sm.restoreFailed": "恢复失败",
        "sm.reopenFailed": "重开失败",
        "sm.relatedDocs": "相关文档",
        "sm.relatedDocsShort": "文档",
        "sm.timeline": "时间线",
        "sm.relatedDocsEmpty": "该会话没有触达过文档",
        "sm.relatedDocsHint": "会话触达过的文档 · aiti-git-trace 采集 → aiti-doc-center 关联",
        "sm.docCenterAbsent": "文档中心未启用（aiti-doc-center）",
        "sm.confirmDeleteArchive": "彻底删除该已归档会话？（先归档才能删除，删后不可恢复）",
        "sm.confirmDeleteArchiveN": "彻底删除 {count} 个已归档会话？删后不可恢复。",
        "sm.clear": "清除",
        "sm.msgCountLabel": "消息数",
        "sm.modelDist": "模型分布",
        "sm.activityHint": "活动（点日期过滤）",
        "sm.todayLine": "今天 +{s} 会话 · +{m} 消息",
        "sm.weekLine": "近 7 天 {n} 消息",
        "sm.sessions": "会话",
        "sm.today": "今天",
        "sm.last24h": "24h",
        "sm.last2d": "2 天",
        "sm.last7d": "7 天",
        "sm.last30d": "30 天",
        "sm.sourcesLabel": "来源",
        "sm.sources.found": "发现 {count} · ",
        "sm.sources.load": "加载",
        "sm.sources.loading": "…",
        "sm.sources.loaded": "已加载",
        "sm.sources.sync": "同步",
        "sm.sources.stale": "⟳ 有更新",
        "sm.sources.staleHint": "检测到新会话——点击下方源区同步。",
        "sm.sources.uninstalled": "未安装",
        "sm.sources.error": "出错",
        "sm.import.button": "⬇ 导入为 pi 会话",
        "sm.import.failed": "导入失败：外部会话缺少 cwd 或 pi sessions 目录不可写。",
        "sm.agentFilter.empty": "未选择任何来源——点击上方来源 chips 选择要查看的 agent",
        "sm.dockAdv": "高级",
        "sm.dockAdvTitle": "高级过滤（来源 agent / 标签）",
        "sm.dockAdvAgents": "来源",
        "sm.dockAdvTags": "标签",
        "sm.tagDocs": "{count} 篇关联文档",
        "sm.tagDocsTip": "携带该 tag 的文档（来自文档中心，含子 tag）",
        "sm.dockAdvDoc": "文档",
        "sm.dockAdvDocPick": "选择文档…",
        "sm.dockAdvDocEmpty": "无文档（文档中心未就绪或未收录）",
        "sm.dockAdvDocCount": "触达 {count} 个会话",
        "sm.viewerSearch": "搜索消息…",
        "sm.viewerNoMatch": "无匹配消息",
        // 查看器聊天式消息区（docs/session-manager-viewer-chat-plan.md §3.5）
        "sm.viewer.user": "用户",
        "sm.viewer.assistant": "助手",
        "sm.viewer.toolResult": "工具结果",
        "sm.viewer.input": "输入",
        "sm.viewer.output": "输出",
        "sm.viewer.lines": "{n} 行",
        "sm.viewer.expandAll": "展开全部（{n} 字）",
        "sm.viewer.collapse": "收起",
        "sm.viewer.copy": "复制",
        "sm.viewer.copied": "已复制",
        "sm.viewer.toTop": "回到顶部",
        "sm.viewer.toBottom": "跳到最新",
        "sm.viewer.filterUser": "显示 / 隐藏用户消息",
        "sm.viewer.filterAssistant": "显示 / 隐藏助手消息",
        "sm.viewer.filterTool": "显示 / 隐藏工具结果",
        "sm.viewer.stats": "显示 {total} 条 · 用户 {user} · 助手 {assistant} · 工具 {tool}",
        "sm.viewer.openImage": "点击打开",
        "sm.viewer.truncated": "… 其余 {n} 行未显示",
        "sm.viewer.extSession": "外部会话",
        "sm.cloudsCollapsed": "标签 / 来源已收拢",
        "sm.expanded": "已展开",
        "sm.scrollToCollapse": "再向下滚动自动收拢",
        "sm.expand": "展开",
        "sm.collapse": "收拢",
      },
    },
  },
};

export default ext;


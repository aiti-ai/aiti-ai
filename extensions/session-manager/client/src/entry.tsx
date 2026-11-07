/**
 * session-manager · client 入口（JSX + TypeScript + vite 构建）。
 *
 * Slots:
 *  - sidebar:    entry button + running-count badge → opens the panel
 *  - toolbar:    same entry (top bar) + kanban + search（feature 门控，默认关）
 *  - dialogs:    SessionsPanel (flat all-sessions list) + TagManager (tree) + ArchivedViewer
 *  - sessionTopbar: current session tag chips + favorite + add-tag
 *  - sessionRowActions: per-session favorite star + tag edit + archive
 *
 * Data: sessions/running from core /api/sessions + /api/agent/running; tag
 * data from the extension's own /api/extensions/session-manager/ endpoints.
 * Mutations go through server-side actions (optimistic version lock; 409 →
 * re-fetch + retry once).
 */

// Keyframes for the panel open fade (T-2): injected once per document.
// A compositor-only opacity animation — opening the dialog never forces a
// synchronous layout of the (potentially large) session list tree.
(function ensurePanelKeyframes() {
  try {
    if (document.getElementById("sm-panel-fade-style")) return;
    const style = document.createElement("style");
    style.id = "sm-panel-fade-style";
    style.textContent = "@keyframes sm-panel-fade { from { opacity: 0 } to { opacity: 1 } }";
    (document.head || document.documentElement).appendChild(style);
  } catch { /* noop */ }
})();

// 查看器弹窗（ExtViewer 外部会话 / ArchivedViewer 归档）滚动条加宽：全局 4px 滚动条
// 在消息区几乎点不到，弹窗作用域内放宽到 12px 命中区（透明边框内缩视觉 ~6px）。
// 注意不要设 scrollbar-width——Chrome 121+ 设了会忽略 ::-webkit-scrollbar 定制。
(function ensureViewerScrollbarStyle() {
  try {
    if (document.getElementById("sm-viewer-scrollbar-style")) return;
    const style = document.createElement("style");
    style.id = "sm-viewer-scrollbar-style";
    style.textContent = [
      ".sm-viewer-float ::-webkit-scrollbar, .sm-viewer-float::-webkit-scrollbar { width: 12px; height: 12px; }",
      ".sm-viewer-float ::-webkit-scrollbar-track, .sm-viewer-float::-webkit-scrollbar-track { background: transparent; }",
      ".sm-viewer-float ::-webkit-scrollbar-thumb, .sm-viewer-float::-webkit-scrollbar-thumb { background: var(--text-dim); border-radius: 7px; border: 3px solid transparent; background-clip: padding-box; }",
      ".sm-viewer-float ::-webkit-scrollbar-thumb:hover, .sm-viewer-float::-webkit-scrollbar-thumb:hover { background-color: var(--text-muted); border-width: 2px; }",
      ".sm-viewer-float ::-webkit-scrollbar-corner, .sm-viewer-float::-webkit-scrollbar-corner { background: transparent; }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  } catch { /* noop */ }
})();

import { __setCtx, t, apiUrl, useState, useEffect, getExtService } from "./host-shim";
import { buildAtText, openNewSession } from "../../../_shared/new-session-cwd";
import {
  refreshSessions, refreshWorkspaces, onTagsChangedFrame, onSessionCreatedFrame, onSessionActivityFrame, onOmpRebindFrame, subscribeRunningFrames, panelOpen, kanbanOpen,
  managerOpen, SM_PANEL_KEY, ARCHIVED_VIEWER_KEY, EXT_VIEWER_KEY, useFlag, openViewer,
} from "./store";
// 跨扩展复用（构建期内联）：aiti-folder 的目录选择器 DirectoryBrowser。它内部引用
// aiti-folder 自己的 host-shim 副本——register 时把同一 ctx 也注入那份副本，
// 其 apiUrl/t 才能委托到宿主（见下方 setAitiFolderCtx）。
import { __setCtx as setAitiFolderCtx } from "../../../aiti-folder/client/src/host-shim";
// 薄壳拆分（2026-09-14，方案 pi-web-eager-ext-split-plan.md §5.1）：
//   重 UI（sessions-panel/tag-manager/kanban/menus 三件套/workspace-manage/aiti-folder
//   DirectoryBrowser）全部懒 chunk；本文件只留 eager 常驻面（store/侧栏行/顶栏标签）
//   + 懒插槽包装（lazyExtView/LazyMount：active 才 import，dialogs/pages 常挂插槽安全）。
import { TopbarTags, RowActions } from "./topbar";
import { ConfirmDialogHost } from "./confirm-dialog";
import { RelatedDocsHost } from "./related-docs";
import { ToastHost, showToast } from "./toast";
import { TagPopoverHost, SidebarRowTags } from "./tag-ui";
import { SidebarEntry, ToolbarSearch } from "./entries";
import { SidebarDock } from "./sidebar-dock";
import { SidebarContentDock } from "./sidebar-content";
import { NewSessionPicker, newSessionPrepare } from "./new-session-picker";
import { useGate, usePresent, seedDockDefault } from "../../../_shared/ext-float-dock-lite";
import { lazyExtView, createLazyModule } from "../../../_shared/ext-lazy";
import type { WorkspaceManageProps } from "./workspace-manage";

// ---- 懒 chunk 引用（面板/看板/标签树/菜单三件套/工作区管理）----
const panelRef = createLazyModule(() => import("./sessions-panel"));
const tagManagerRef = createLazyModule(() => import("./tag-manager"));
const kanbanRef = createLazyModule(() => import("./kanban"));
const rowMenuRef = createLazyModule(() => import("./row-menu"));
const archiveMenuRef = createLazyModule(() => import("./archive-menu"));
const moveDialogRef = createLazyModule(() => import("./move-dialog"));
const workspaceManageRef = createLazyModule(() => import("./workspace-manage"));
const workspaceUploadRef = createLazyModule(() => import("./workspace-upload"));

// dock 双 face：同一内容组件两处注册，各自经 useGate 门控——状态机保证至多一个 face 渲染。
// 浮窗 face = SessionsPanel（全功能管理面板）；停靠 face = PanelDockFace（DockBody 包
// embedded 面板，组件在 sessions-panel 懒 chunk 内）。薄壳拆分后：gate 在本文件（lite 层），
// import 在门控开启后才发生（dialogs/rightFileDock 常挂插槽，绝不能挂 mount）。
// ⚠️ 全部 face 透传插槽 props（2026-09-17）：此前 lazyExtView 未传 props → SessionsPanel/
//    KanbanPage 等读 props.onSelectSession（dialogs/pages extra，宿主 AppShell 下发）恒
//    undefined → 浮窗/看板点 pi 会话行静默不打开。dialogs extra 有真实消费（newSessionCwd
//    → aiti-plan-first、currentSession → extman/git-trace），不可省略转发。
function PanelFloatFace(props: any) {
  const show = useGate(SM_PANEL_KEY, "float");
  return lazyExtView({ active: show, load: panelRef, pick: "SessionsPanel", props });
}
function PanelDockFaceLazy(props: any) {
  const show = useGate(SM_PANEL_KEY, { dock: "right-panel" });
  return lazyExtView({ active: show, load: panelRef, pick: "PanelDockFace", props });
}
function ArchivedViewerLazy(props: any) {
  const st = usePresent(ARCHIVED_VIEWER_KEY);
  return lazyExtView({ active: st === "floating", load: panelRef, pick: "ArchivedViewer", props });
}
function ArchivedViewerDockFaceLazy(props: any) {
  const st = usePresent(ARCHIVED_VIEWER_KEY);
  return lazyExtView({ active: st === "docked:right-panel", load: panelRef, pick: "ArchivedViewerDockFace", props });
}
function ExtViewerLazy(props: any) {
  const st = usePresent(EXT_VIEWER_KEY);
  return lazyExtView({ active: st === "floating", load: panelRef, pick: "ExtViewer", props });
}
function ExtViewerDockFaceLazy(props: any) {
  const st = usePresent(EXT_VIEWER_KEY);
  return lazyExtView({ active: st === "docked:right-panel", load: panelRef, pick: "ExtViewerDockFace", props });
}
function TagManagerLazy(props: any) {
  const open = useFlag(managerOpen);
  return lazyExtView({ active: open, load: tagManagerRef, pick: "TagManager", props });
}
function KanbanPageLazy(props: any) {
  const open = useFlag(kanbanOpen);
  return lazyExtView({ active: open, load: kanbanRef, pick: "KanbanPage", props });
}

// ---- 懒 chunk 宿主（菜单三件套）：打开动作（行 ⋮ / 📦 / 移动到…）负责 load，
// 本宿主只订阅「模块已就绪」再挂实现——mount 不 import（§3.3 常挂插槽红线）。
// ⚠ 2026-09-14 薄壳拆分回归修复：打开动作走的是独立 import（session-row menuChunk /
// topbar archiveChunk / sessions-panel 静态依赖），与 createLazyModule 的 ref 就绪互不
// 通知——模块加载了但本宿主一直渲染 null → 菜单（RowMenuHost/ArchiveMenuHost/MoveDialogHost）
// 永不挂载 → 点击 ⋮/📦/移动到… 无反应。这里挂载时主动 load() 兜底（幂等；三个 chunk
// 共约 35KB，常驻成本可忽略）保证宿主就绪、订阅模块态。 ----
function RowMenuHostLazy() {
  const mod = rowMenuRef.useModule();
  useEffect(() => { void rowMenuRef.load(); }, []);
  const Impl = mod?.RowMenuHost as React.ComponentType | undefined;
  return Impl ? <Impl /> : null;
}
function ArchiveMenuHostLazy() {
  const mod = archiveMenuRef.useModule();
  useEffect(() => { void archiveMenuRef.load(); }, []);
  const Impl = mod?.ArchiveMenuHost as React.ComponentType | undefined;
  return Impl ? <Impl /> : null;
}
function MoveDialogHostLazy() {
  const mod = moveDialogRef.useModule();
  useEffect(() => { void moveDialogRef.load(); }, []);
  const Impl = mod?.MoveDialogHost as React.ComponentType | undefined;
  return Impl ? <Impl /> : null;
}

// 工作区上传（方案 docs/session-manager-workspace-upload-plan.md）：同管理入口的懒 chunk 范式
// —— hooks 无条件调用（Rules of Hooks），active 门控收起态不 import，只渲染轻量触发按钮。

// 上传能力服务化（v2 Workspace Hub 复用）：跨扩展 open 通道。模块级 pending 回调 +
// window 事件（`sm:open-upload-dialog`）通知常驻宿主组件 UploadDialogServiceHost
// （dialogs 插槽注册）拉起既有 UploadDialog；成功/关闭回调解耦，上传零重实现。
let uploadSvcPending: { onSelect: (root: string) => void; onClose: () => void } | null = null;
export function openWorkspaceUploadDialog(cb: { onSelect: (root: string) => void; onClose: () => void }): void {
  uploadSvcPending = cb;
  try { window.dispatchEvent(new CustomEvent("sm:open-upload-dialog")); } catch { /* ignore */ }
}
function consumeUploadSvcPending(): { onSelect: (root: string) => void; onClose: () => void } | null {
  const cb = uploadSvcPending;
  uploadSvcPending = null;
  return cb;
}

/** dialogs 插槽常驻组件：上传服务宿主（空闲返回 null；`sm:open-upload-dialog` 事件
 *  拉起既有 UploadDialog lazy chunk——第三方 open() 的唯一渲染面）。 */
function UploadDialogServiceHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => {
      if (consumeUploadSvcPending()) setOpen(true);
    };
    try { window.addEventListener("sm:open-upload-dialog", onOpen); } catch { /* ignore */ }
    return () => { try { window.removeEventListener("sm:open-upload-dialog", onOpen); } catch { /* ignore */ } };
  }, []);
  const dialog = lazyExtView({
    active: open,
    load: workspaceUploadRef,
    pick: "UploadDialog",
    props: {
      onCloseDialog: () => setOpen(false),
      onSelect: (root: string) => {
        setOpen(false);
        try {
          const svc = getExtService<{ setCwd?: (path: string) => void }>("pi-web.newSession");
          if (svc?.setCwd) svc.setCwd(root);
          else showToast(t("sm.uploadSwitchHint"));
        } catch { showToast(t("sm.uploadSwitchHint")); }
      },
    },
  });
  return open ? <>{dialog}</> : null;
}

function WorkspaceUploadEntryLazy(props: { onSelect: (root: string) => void; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const dialog = lazyExtView({ active: open, load: workspaceUploadRef, pick: "UploadDialog", props: { onSelect: props.onSelect, onCloseDialog: () => setOpen(false) } });
  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{
          display: "flex", alignItems: "center", gap: 7,
          width: "100%", padding: "8px 10px", background: "none", border: "none",
          color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11,
        }}
        title={t("sm.uploadWorkspaceTitle")}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {t("sm.uploadWorkspace")}
      </button>
    );
  }
  return <>{dialog}</>;
}

// 新建会话条上传按钮（newSessionSelectors 插槽：渲染在 Workspace select 之后、Branch/Worktree 与
// Backend 之前——紧贴工作区下拉，方案 session-manager-workspace-upload-plan.md §12.1）。
// 样式对齐该行 Workspace/Backend select 盒子（bg-hover + border 圆角 + fontSize 12）。
// onSelect 走宿主 "pi-web.newSession" 服务 setCwd（把新会话 Workspace 切到解压目录）；服务缺席（旧宿主）降级 toast。
function NewSessionUploadButton(props: { cwd: string | null; isMobile: boolean }) {
  const [open, setOpen] = useState(false);
  const dialog = lazyExtView({
    active: open,
    load: workspaceUploadRef,
    pick: "UploadDialog",
    props: {
      onCloseDialog: () => setOpen(false),
      onSelect: (root: string) => {
        try {
          const svc = getExtService<{ setCwd?: (path: string) => void }>("pi-web.newSession");
          if (svc?.setCwd) svc.setCwd(root);
          else showToast(t("sm.uploadSwitchHint"));
        } catch { showToast(t("sm.uploadSwitchHint")); }
      },
    },
  });
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={t("sm.uploadWorkspaceTitle")}
        aria-label={t("sm.uploadWorkspace")}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "4px 8px",
          background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8,
          color: "var(--text)", font: "inherit", fontSize: 12,
          cursor: "pointer",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-muted)" }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {!props.isMobile && <span>{t("sm.uploadWorkspace")}</span>}
      </button>
      {dialog}
    </>
  );
}

// 工作区管理：触发按钮轻量常驻（workspacePickerActions 渲染型条目），弹窗体懒 chunk
function WorkspaceManageEntryLazy(props: WorkspaceManageProps) {
  const [open, setOpen] = useState(false);
  // lazyExtView 内含 hooks（useState/useEffect），必须**无条件**调用——旧写法把它放在
  // `if (!open) return <button/>` 之后，open 翻转时 hook 数变化（previous 1 / next 2）
  // 直接触发 Rules of Hooks 崩溃，被 ExtItemBoundary 静默收起（点「管理」按钮无反应、
  // 入口消失）。active 门控在 lazyExtView 内部：收起态不 import，只渲染轻量触发按钮。
  const dialog = lazyExtView({ active: open, load: workspaceManageRef, pick: "ManageDialog", props: { ...props, onCloseDialog: () => setOpen(false) } });
  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{
          display: "flex", alignItems: "center", gap: 7,
          width: "100%", padding: "8px 10px", background: "none", border: "none",
          color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11,
        }}
        title={t("sm.manageWorkspacesTitle")}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {t("sm.manageWorkspaces")}
      </button>
    );
  }
  return dialog;
}

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）。
  // 第二行给跨扩展导入进来的 aiti-folder host-shim 副本注入同一 ctx。
  __setCtx(ctx);
  setAitiFolderCtx(ctx);

  // 跨扩展「提及/新会话」能力（@ 到新会话收口：buildAtText + openNewSession；CWD 判定走
  // _shared/new-session-cwd——git-trace 端点复核关注路径）。消费方：doc-center/editor/folder
  // （经 openNewSessionWithExtSvc 优先本服务，缺席降级同源实现——见 docs/pi-web-at-new-session-cwd-plan.md §4.5）。
  try {
    const registerExtService = (ctx as { registerExtService?: (k: string, impl: unknown) => void }).registerExtService;
    registerExtService?.("session-manager.mention", {
      buildAtText,
      openNewSession: (text: string, o: { targetDir: string; targetPath?: string | null; currentCwd?: string | null }) =>
        openNewSession({ text, targetDir: o.targetDir, targetPath: o.targetPath, currentCwd: o.currentCwd, apiUrl }),
    });
  } catch { /* 宿主无 registerExtService（旧版）→ 消费方降级 _shared，行为不变 */ }

  // 统一大调用闭环（payload 方案）：接管态宿主侧栏已停全量拉，外部触发
  //（宿主 Header 刷新按钮 / 其他扩展 notifySessionsChanged）→ 本扩展 store 刷新
  // （ETag/304 + 并发合流节流；notify 本身不在此监听器路径上，无循环）。
  try {
    window.addEventListener("sm:sessions-changed", () => { void refreshSessions(); });
  } catch { /* non-DOM */ }

  // 跨 tab 会话列表帧分发：新会话创建（rpc-manager publish，草稿行+补拉转正）+
  // 会话活动（本扩展 agent message_end 后 publish，运行中行数据实时刷新）。
  // 两个 handler 各自按 type 自过滤，同一分发函数挂 broker/总线两条通道安全。
  const onSessionListFrame = (frame: Record<string, unknown>) => {
    onSessionCreatedFrame(frame);
    onSessionActivityFrame(frame);
    onOmpRebindFrame(frame);
  };

  // 跨 tab「新会话创建」帧（服务端 rpc-manager 全新会话启动成功后 publish）：
  // 记草稿行 + 有界补拉兑底落盘转正（store.onSessionCreatedFrame）。常驻订阅挂
  // register（页面级，不随组件卸载）；subscribeRunningFrames 优先宿主共享 broker、
  // 旧宿主回退原生 EventSource——两形态都投递全部 message 帧（含本帧），handler
  // 内按 type 自过滤，其余帧（pf:remind/mc:avail/ed-watch…）不受影响。
  try {
    subscribeRunningFrames(onSessionListFrame);
  } catch { /* non-DOM */ }

  // ⚠ 总线模式下上面那条订阅收不到本帧（2026-09-12 dev 实测）：running broker 经
  // getEventBus 单 topic 订阅（白名单只有 "running"），总线按 type 白名单过滤——
  // sm:session-created 帧在总线 SSE 上有、页面 __piPageEventsClient 只见心跳，
  // 侧栏草稿行不出现（fallback 模式 core route SSE 帧全量携带，掩盖了该缺口）。
  // 补总线主题订阅（同一 handler；store 按 sessionId 幂等，重复帧无害）。
  // 走 window.__piEventBus 槽 + piwe-event-bus-ready 等待（core event-bus-client
  // 「排队不回退」同款）——实测经 ext service（aiti-event-bus.subscribe-topics）在
  // register 时取不到：materialize 并行，aiti-event-bus 的服务注册晚于本扩展
  // register，getExtService 返回 undefined 即永久漏订（探针后挂同时订同 topic 能收）。
  // 总线真缺席（manifest 定案未部署）时 ready 永不来 → 不订阅，fallback 模式
  // running 通道（core route SSE 帧全量）本就携带本帧，无缺口。
  try {
    const busSlot = () => (window as {
      __piEventBus?: { subscribeTopics?: (h: (f: Record<string, unknown>) => void, types: string[]) => unknown };
    }).__piEventBus;
    const trySubBus = () => {
      const sub = busSlot()?.subscribeTopics;
      if (typeof sub === "function") {
        sub(onSessionListFrame, ["sm:session-created", "sm:session-activity", "aiti-omp-agent:rebind"]);
        return true;
      }
      return false;
    };
    if (!trySubBus()) {
      window.addEventListener("piwe-event-bus-ready", trySubBus, { once: true });
    }
  } catch { /* 非 DOM 环境 → fallback 通道已覆盖 */ }

  // tag 数据变更 → event-bus 帧驱动刷新（页面级常驻订阅，不随组件卸载）：
  // 服务端在每次 tag 写成功（act/PUT/懒 GC）后广播 sm:tags-changed { version }，
  // 本 tab 保存后本地已落地（版本守卫跳过），跨 tab/跨实例/其他入口的变更帧才触发
  // refreshTags(true)。首次拉取不再由这里负责——各调用点 ensureTags 懒加载（真用到才首拉）。
  // 防御式：优先 aiti-event-bus 客户端服务（aiti-event-bus.subscribe），缺席回退
  // core 旧 route（__piPageEventsClient），再缺席静默（退化为首次懒加载 + 本 tab 本地落地）。
  try {
    const busSub = (ctx as { getExtService?: <T>(k: string) => T | undefined })?.getExtService?.(
      "aiti-event-bus.subscribe",
    );
    // 常驻订阅：不随 register 生命周期退订（与上方 sm:sessions-changed 监听同策略）；
    // 重复 register（hydration 重挂）时 aiti-event-bus 的 frameListeners 是 Set，
    // onTagsChangedFrame 同一函数引用天然去重，不会叠 listener。
    if (typeof busSub === "function") {
      (busSub as (h: (f: Record<string, unknown>) => void) => () => void)(onTagsChangedFrame);
    } else {
      (window as unknown as { __piPageEventsClient?: { subscribePageFrames?: (h: (f: Record<string, unknown>) => void) => () => void } })
        .__piPageEventsClient?.subscribePageFrames?.(onTagsChangedFrame);
    }
  } catch { /* non-DOM */ }
  // 负总责首拉：register 即拉（早于 dock 首帧渲染，减少空列表窗口；合流节流去重）
  // [通道拆分] 快通道不等 dock 挂载：项目列表原先只在 SidebarList 的 mount effect 里拉，
  // 项目区块折叠 / 首帧慢（手机端 bundle 数秒）时下拉点开就是空的，且要等切会话或手动刷新
  // 才有机会重试（2026-09-22 用户报「workspace 下拉有时不显示」）。
  void refreshWorkspaces();
  // 全量通道延后启动（快通道 workspaces/scoped 先落地、不抢占事件循环）：
  // 宿主 catalog（家族树）/All Sessions 面板数据由延后全量继续供数，行为不变。
  setTimeout(() => { void refreshSessions(); }, 1200);

  ctx.registerItems?.("pages", [{ id: "kanban", render: KanbanPageLazy }]);

  ctx.registerItems?.("sidebar", [{ id: "sessions", render: SidebarEntry }]);
  ctx.registerItems?.("toolbar", [
    // sessions/kanban：声明式条目（meta.icon + meta.onClick，无 render）——行内 ExtToolbarIconButton、
    // ⋯ 菜单 metaIcon 形态、定制预览/离屏测量全归宿主统一渲染（与 configs/git-review 等同契约）。
    // 旧自绘 ToolbarEntry/KanbanEntry 与宿主标准按钮逐像素同款，属声明式契约前的遗留，已删；
    // 自绘时代的渲染型 onClick 也一并消除（panelOpen/kanbanOpen 转发进 meta.onClick）。
    { id: "sessions", meta: { label: t("sm.allSessions"), icon: "icons/message-square.svg", onClick: () => panelOpen.onOpen() } },
    // feature 门控（index.ts features 声明，default:false）：宿主 getExtUiItems 按此过滤——
    // 关闭时条目不渲染（含 ⋯ 菜单/自定义顶栏），extman「功能管理」打开后即时恢复，无需扩展自写判断。
    // 全插槽唯一保留 render 的条目：真交互组件（输入框），⋯ 菜单内由宿主挂载（menu=true 窄版）。
    { id: "search", render: ToolbarSearch, meta: { label: "搜索会话", icon: "icons/search.svg", noMenuLabel: true }, feature: "toolbar.search" },
    { id: "kanban", meta: { label: t("sm.kanban"), icon: "icons/square-kanban.svg", onClick: () => kanbanOpen.onOpen() } },
  ]);
  // aiti-float dock v3（P3 批）：三个面板接右栏停靠 face（主面板无 default；两个查看器默认右栏）
  seedDockDefault("session-manager:ext-viewer", "right-panel");
  seedDockDefault("session-manager:archived-viewer", "right-panel");
  ctx.registerItems?.("rightFileDock", [
    { id: "panel", render: PanelDockFaceLazy, meta: { title: "All Sessions" } },
    { id: "archived-viewer", render: ArchivedViewerDockFaceLazy, meta: { title: "归档查看器" } },
    { id: "ext-viewer", render: ExtViewerDockFaceLazy, meta: { title: "外部会话" } },
  ]);
  ctx.registerItems?.("dialogs", [
    { id: "panel", render: PanelFloatFace },
    { id: "archived-viewer", render: ArchivedViewerLazy },
    { id: "ext-viewer", render: ExtViewerLazy },
    { id: "tags-manager", render: TagManagerLazy },
    // 标签弹层常驻宿主：侧栏行 hover 卸载不影响弹层（模块级状态，见 tag-ui.tsx）
    { id: "tag-popover", render: TagPopoverHost },
    // 归档 4 选项常驻宿主：同 tag-popover 模式，行 hover 卸载不影响弹层
    { id: "archive-popover", render: ArchiveMenuHostLazy },
    // 自绘确认弹窗宿主（替换浏览器原生 confirm/alert 的彻底删除确认等）
    { id: "confirm-dialog", render: ConfirmDialogHost },
    // 相关文档弹层宿主（会话触达文档，aiti-doc-center services 进程内消费）
    { id: "related-docs", render: RelatedDocsHost },
    // 行「⋮」菜单常驻宿主（row-menu.tsx）：All Sessions 行 + SidebarDock 左栏行两面共用；
    // z 2147483500 高于 aiti-float 抬升上限，不依赖面板 overlay 抬升
    { id: "row-menu", render: RowMenuHostLazy },
    // 移动会话弹窗宿主（move-dialog.tsx）：面板/dock 行菜单「移动到…」同一弹窗（showMoveDialog 触发）
    { id: "move-dialog", render: MoveDialogHostLazy },
    // 轻量非模态提示宿主（toast.tsx）：桥占用无法自动命名等降级原因说明
    { id: "toast", render: ToastHost },
  ]);
  ctx.registerItems?.("sessionTopbar", [{ id: "tags", render: TopbarTags, meta: { label: "标签" } }]);
  // 「项目 / Projects」左栏接管（宿主 SessionSidebar 项目区替换渲染；无 cwd 时显示全部，
  // 数据 = 本扩展 /sessions API）。宿主渲染折叠头，扩展只出列表本体。
  ctx.registerItems?.("sidebarProjects", [{ id: "dock", render: SidebarDock }]);
  // 左栏整块接管（sidebar 统一 dock 方案 §3.2）：AppShell 层 SidebarContentDock 自编排
  // （Header + DockStack 区块栈 + 底部行）。新宿主消费本插槽（接管优先）；
  // 旧宿主无 sidebarContent 消费方 → 恒回退 sidebarProjects 形态——双声明两形态兼容。
  ctx.registerItems?.("sidebarContent", [{ id: "master", render: SidebarContentDock }]);
  // SessionSidebar 行内 meta：会话 tag 小胶囊（部分展开，点击弹该会话 tag 管理菜单）。
  // 渲染序在 aiti-plan-first 方案标之后——两扩展均启动即加载，注册序 = 扩展发现序
  // （字典序 aiti-plan-first < session-manager）→ ExtSlot 按注册序渲染；
  // 改扩展 id / 加载时机时留意这层隐式依赖。
  ctx.registerItems?.("sessionRowMeta", [{ id: "session-tags", render: SidebarRowTags }]);
  ctx.registerItems?.("sessionRowActions", [{ id: "actions", render: RowActions }]);
  // 管理工作区列表（CWD picker 下拉底部）：选择/隐藏/删除（移动全部或归档）
  // 上传工作区（同插槽，放管理之上——高频动作优先，方案 session-manager-workspace-upload-plan.md）
  ctx.registerItems?.("workspacePickerActions", [
    { id: "upload", render: WorkspaceUploadEntryLazy },
    { id: "manage", render: WorkspaceManageEntryLazy },
  ]);
  // 新建会话条（ChatWindow Workspace×Backend flex 行，方案 session-manager-workspace-upload-plan.md §12.1）：
  // 上传按钮注册为 newSessionSelectors 首条目——渲染序 = Workspace select 之后紧贴下拉（用户指定位置），
  // Branch/Worktree 选择器与 Backend 之前；上传完成后经宿主 "pi-web.newSession" 服务 setCwd 切换 Workspace
  // （旧宿主无服务降级 toast）。注：右上角 newSessionContextBar 侧的 newSessionContextTrailing 插槽已撤
  // （bar 实际渲染在版本信息旁，用户不可理解；宿主插槽机制保留，扩展端不再注册）。
  ctx.registerItems?.("newSessionSelectors", [
    { id: "upload", render: NewSessionUploadButton },
    { id: "picker", render: NewSessionPicker },
  ]);
  ctx.registerItems?.("newSessionPreparers", [{ id: "picker", meta: { prepare: newSessionPrepare } }]);

  // 上传能力服务化（v2 Workspace Hub 复用，aiti-quickstart soft-depend）：UploadDialog
  // 开关提为模块级 store（window 事件 + 常驻宿主组件）——第三方 open({onSelect,onClose})
  // 直接驱动既有弹窗，上传零重实现。服务缺席（本扩展禁用）时消费方降级提示。
  // dialogs 常驻条目（二分诊断摘除）：若侧栏恢复 = UploadDialogServiceHost 渲染是崩点
  // ctx.registerItems?.("dialogs", [{ id: "upload-dialog-service", render: UploadDialogServiceHost }]);
  const disposeUploadSvc = typeof ctx.registerExtService === "function"
    ? ctx.registerExtService("session-manager.uploadWorkspace", { open: openWorkspaceUploadDialog })
    : null;

  // 跨扩展唤起归档查看器通道：sm:open-archived { detail: { id: <sid> } }。
  // 生产方：aiti-doc-center（归档会话在消息区不可打开——jsonl 已进 .pwarc 容器，
  // 宿主 pi-web:open-session 找不到静默失败；服务端 services.sessions.archivedIds()
  // 是同一扩展的另一面，扩展缺席时生产方根本不发事件，降级天然一致）。
  // 幂等：viewerState 置同 id 重复唤起无害；archived-viewer 是宿主 dialogs slot
  // 独立 dialog，不依赖主面板打开。
  if (!(window as any).__smOpenArchivedBound) {
    (window as any).__smOpenArchivedBound = true;
    window.addEventListener("sm:open-archived", (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (typeof id === "string" && id) openViewer(id);
    });
  }
}

/**
 * aiti-folder · client 入口（JSX + TypeScript + vite 构建）。
 *
 * 注册两项（均复用核心端点）：
 *  - fileViewer 项 aiti-folder：match kind==="folder" → FolderBrowser
 *  - pathPicker 项 aiti-folder-picker：FolderSwitcher（能力，不切 cwd）
 *
 * 开放点：window.__aitiFolder.registerAction（其他扩展注册目录级工具条按钮）
 * [懒加载 v2 D3] 薄入口拆包：FolderBrowser（~113K）按需 import()；本文件 + pathPicker
 * + registerAction 开放点为薄入口（~8K），随启动物化即时可用。
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */
import { useState, useEffect } from "react";
import { __setCtx, extSvc, t } from "./host-shim";
import { registerAction } from "./folder-actions";
import { FolderSwitcher } from "./folder-switcher";
import { syncFolderDockFaces, INSTANCES_EVENT, openFolderDocked } from "./folder-dock";
import { CommitHost, openCommit } from "./commit-service";
import { PickHost, pickDirectory } from "./pick-service";
import { setupCommitActions } from "./commit-actions";

// [懒加载 v2 D3 拆包] FolderBrowser（目录树/预览，~113K 大头）按需 import()：
// 薄入口（本文件 + pathPicker + registerAction 开放点）随启动物化即时可用；
// 首次真正渲染目录 tab 时才拉重 chunk（加载期返回 null——接管判定已由 match 先行命中）。
let FolderBrowserComp: ((props: any) => unknown) | null = null;
function FolderBrowserLazy(props: Record<string, unknown>) {
  const [, force] = useState(0);
  useEffect(() => {
    // 每个实例独立等 import 完成后各自唤醒（同 URL 模块加载浏览器天然去重；
    // 不设全局 loading 标志——否则并发挂载的第二个实例永远等不到重渲染）
    let alive = true;
    import("./folder-browser").then((m) => {
      if (!alive) return;
      FolderBrowserComp = m.FolderBrowser;
      force((n) => n + 1);
    });
    return () => { alive = false; };
  }, []);
  // 必须以 JSX 组件渲染（<Comp {...props}/>），严禁普通函数调用 Comp(props)：
  // 函数调用会把 FolderBrowser 的 ~50 个 hooks 并进本薄壳的 hook 链——首渲染只挂 1 个
  // hook（返回 null 等加载），加载完成后 force 重渲染变成 1+N 个，React 更新路径发现
  // hook 列表越界 → #310「Rendered fewer hooks than expected」崩溃（2026-09-08 修复）。
  const Comp = FolderBrowserComp;
  return Comp ? <Comp {...(props as any)} /> : null;
}

// 开放点暴露（其他扩展注册目录级工具条按钮；aiti-git-review 的「审此目录」用它）
// openFolderDocked：其他扩展可显式把目录以 dock face 落右栏（带全套 ⇱ 停靠菜单）
try { (window as any).__aitiFolder = { registerAction, openFolderDocked }; } catch { /* noop */ }
// 就绪广播（开页方案 §1 F5）：aiti-git-review「审此目录」动作晚注册用（同 aiti-editor:ready 注）
try { window.dispatchEvent(new CustomEvent("aiti-folder:ready")); } catch { /* noop */ }

/** 打开终端（薄入口轻量版）：宿主统一入口 pi-web.ui.onOpenTerminal（右栏工作区终端 tab，同 cwd
 *  复用已开 tab 防双开）——与 folder-browser.openTerminal 主路径同源；宿主服务缺席才拉重 chunk 走
 *  完整兜底链（__aitiCmd 遗留 / 服务端系统终端窗）。 */
function openTerminalAt(cwd: string): void {
  try {
    const hostUi = extSvc<{ get?: (name: string) => unknown }>("pi-web.ui");
    const open = hostUi?.get?.("onOpenTerminal") as ((cwd: string, forceNew?: boolean) => void) | undefined;
    if (typeof open === "function") { open(cwd); return; }
  } catch { /* 服务缺席——走后续回退 */ }
  import("./folder-browser").then((m) => m.openTerminal(cwd)).catch(() => {});
}

/** 当前项目 cwd（权威 = 会话工作区；ai-folder 文件面板 root 也跟随它）。无会话返回空。 */
function currentSessionCwd(): string {
  try {
    const sess = extSvc<{ get?: () => { session?: { cwd?: string } | null } }>("pi-web.session");
    return sess?.get?.()?.session?.cwd || "";
  } catch { return ""; }
}

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  // 命令目录槽（宿主无渲染点；aiti-app-center 动作卡 + 输入命令提示消费，方案
  // docs/aiti-ai-input-app-command-hints-plan.md §9）：「打开终端」= 当前项目（会话 cwd）
  // 打开右栏工作区终端 tab——与左栏文件区块头行按钮同源能力，无需占用任何 UI 槽。
  ctx.registerItems?.("commands", [{
    id: "open-terminal",
    // 声明式条目约定：label/icon/meta 都在 meta 内（buildApps 读 meta.label/meta.icon；宿主工具条同构）
    meta: {
      label: t("files.openTerminal") || "打开终端",
      icon: { svg: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
      onClick: () => { const cwd = currentSessionCwd(); if (cwd) openTerminalAt(cwd); },
    },
  }]);

  ctx.registerItems?.("fileViewer", [{
    id: "aiti-folder",
    render: (props: Record<string, unknown>) => <FolderBrowserLazy {...props} />,
    meta: { label: "i18n:it.folder.label", title: "aiti-folder: folder browser", match: (_fp: unknown, opts: any) => opts && opts.kind === "folder" },
  }]);
  ctx.registerItems?.("pathPicker", [{
    id: "aiti-folder-picker",
    // 选中目录走本扩展 dock 状态机（openFolderDocked）而非宿主 onSelect（handleOpenFolder
    // 开旧式文件夹 tab——不在 dock 状态机里，tab 条无 ⇱ 浮窗/停靠菜单）。拦截 onSelect
    // 纯扩展侧闭环：宿主 onSelect 仅用于无本扩展时的兜底路径，此处覆盖后不再触达。
    render: (props: Record<string, unknown>) => (
      // Host topbar passes onSelect (open the folder); generic consumers (e.g. the
      // video studio workspace picker) pass their own callback. Only fall back to the
      // dock behavior when no caller callback was supplied.
      <FolderSwitcher {...(props as any)} onSelect={(p: string) => {
        // The host topbar passes compact=true and historically the folder extension
        // docked the picked folder; preserve that. Embedded pickers (video studio
        // workspace dialog) pass no compact and receive the path via onSelect.
        if ((props as any).compact === true) openFolderDocked(p, "right-panel");
        else if (typeof (props as any).onSelect === "function") (props as any).onSelect(p);
        else openFolderDocked(p, "right-panel");
      }} />
    ),
    meta: { label: "i18n:it.folder-picker.label", title: "aiti-folder: directory switcher (no cwd change)" },
  }]);

  // Cross-extension services (DI): commit dialog prefill + directory picker (consumed by aiti-codehub etc.)
  ctx.registerItems?.("dialogs", [
    { id: "commit-host", render: () => <CommitHost /> },
    { id: "pick-host", render: () => <PickHost /> },
  ]);
  try { (ctx as any).registerExtService?.("aiti-folder.commit", { open: openCommit }); } catch { /* old host */ }
  try { (ctx as any).registerExtService?.("aiti-folder.pick", { directory: pickDirectory }); } catch { /* old host */ }
  // Commit-dialog action row slot: other extensions register buttons (aiti-codehub "Work item")
  setupCommitActions(ctx as Record<string, any>);

  // 多实例 dock faces（v2）：左栏栈/浮窗/右栏三面按清单动态注册；instances 变化
  // （项目切换自动加 / ＋ 选择器 / 钉住 / FIFO 挤出）→ 事件驱动重注册（零轮询）。
  try {
    const resync = () => { try { syncFolderDockFaces(ctx); } catch { /* noop */ } };
    resync();
    window.addEventListener(INSTANCES_EVENT, resync);
    window.addEventListener("storage", resync);
  } catch { /* noop */ }

  try { console.log("[aiti-folder] client 已挂载（fileViewer 文件夹接管 + pathPicker 目录选择器 + registerAction 开放点 + dock faces 多实例）"); } catch { /* noop */ }
}

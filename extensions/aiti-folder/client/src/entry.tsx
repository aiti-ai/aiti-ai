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
import { __setCtx } from "./host-shim";
import { registerAction } from "./folder-actions";
import { FolderSwitcher } from "./folder-switcher";
import { syncFolderDockFaces, INSTANCES_EVENT, openFolderDocked } from "./folder-dock";

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

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  ctx.registerItems?.("fileViewer", [{
    id: "aiti-folder",
    render: (props: Record<string, unknown>) => <FolderBrowserLazy {...props} />,
    meta: { label: "文件夹", title: "aiti-folder: folder browser", match: (_fp: unknown, opts: any) => opts && opts.kind === "folder" },
  }]);
  ctx.registerItems?.("pathPicker", [{
    id: "aiti-folder-picker",
    // 选中目录走本扩展 dock 状态机（openFolderDocked）而非宿主 onSelect（handleOpenFolder
    // 开旧式文件夹 tab——不在 dock 状态机里，tab 条无 ⇱ 浮窗/停靠菜单）。拦截 onSelect
    // 纯扩展侧闭环：宿主 onSelect 仅用于无本扩展时的兜底路径，此处覆盖后不再触达。
    render: (props: Record<string, unknown>) => (
      <FolderSwitcher {...(props as any)} onSelect={(p: string) => openFolderDocked(p, "right-panel")} />
    ),
    meta: { label: "目录选择", title: "aiti-folder: directory switcher (no cwd change)" },
  }]);

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

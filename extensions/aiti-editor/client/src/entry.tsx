/**
 * aiti-editor · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx)：
 *   1) 装配编辑器注册表单例（window.__aitiEditor：providers/languages/services/
 *      actions、编辑缓存、session 墓碑制、confirmClose 阻止机制）
 *   2) fileViewer slot 接管组件（EditorApp，Monaco/Markdown/二进制查看器）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */
import { __setCtx } from "./host-shim";
import { setCtx } from "./env";
import { installSessionService } from "./session-svc";
import { setupRegistry, canTakeover } from "./registry";
import { initOpenWithContextMenu } from "./openwith-menu";
import { EditorApp } from "./editor-app";
import { ImageFloatFace, ImageDockRightFace, openImagePreview } from "./image-float";
import { loadMonaco } from "./monaco-setup";
import {
  syncFileDockFaces, INSTANCES_EVENT,
  hasFileFace, openFileFace, dockFile, closeFileFace,
} from "./file-dock";

export default function register(ctx: Record<string, any>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);
  setCtx(ctx);
  // 统一会话状态服务订阅（pi-web.session）：session 墓碑只在 active 时取 canonical id。
  installSessionService(ctx);

  // 编辑器注册表 + 内置语言/provider/service 注册（幂等：window.__aitiEditor 单例已存在则只补 session 部分）
  setupRegistry(ctx);

  // FileExplorer 右键「打开方式」（M0 位置 C）：document 级监听，仅多编辑器候选文件拦截
  initOpenWithContextMenu();

  ctx.registerItems?.("fileViewer", [{
    id: "aiti-editor",
    render: (props: Record<string, any>) => <EditorApp {...props} />,
    meta: {
      label: "Editor",
      title: "aiti-editor: text file editor (Monaco)",
      match: (filePath: string, opts: any) => (opts && opts.kind === "folder") ? false : canTakeover(filePath),
    },
  }]);

  // 图片预览（dialogs 浮层 + rightFileDock 右栏停靠两面；宿主入口经 __aitiEditor.openImagePreview
  // 调用）——消息/输入框/markdown 图片（无磁盘路径）统一由本扩展承载，宿主无图片预览容器。
  // 默认浮窗；浮窗面板声明 data-ext-float-dock → aiti-float 注入 ⇱ 停靠右栏（audit-fix §9.1）。
  ctx.registerItems?.("dialogs", [{
    id: "image-preview",
    render: () => <ImageFloatFace />,
    meta: { label: "图片预览", title: "aiti-editor: image preview overlay" },
  }]);
  ctx.registerItems?.("rightFileDock", [{
    id: "image-preview",
    render: () => <ImageDockRightFace />,
    meta: { title: "图片预览" },
  }]);

  // 文件 dock faces（右栏 dock tab / 左栏区块 / 浮窗；方案 docs/file-dock-face-plan.md）：
  // 实例变化（⇱ 停靠 / 关闭 / 跨 tab storage）→ 事件驱动重注册（零轮询）。
  try {
    const resync = () => { try { syncFileDockFaces(ctx); } catch { /* noop */ } };
    resync();
    window.addEventListener(INSTANCES_EVENT, resync);
    window.addEventListener("storage", resync);
  } catch { /* noop */ }

  // 宿主消费的 face API（挂 __aitiEditor 单例上——宿主 AppShell/TabBar 经 window 可选调用，
  // 扩展缺席/未挂载时全部降级）。register 幂等路径（单例已存在）同样覆盖。
  try {
    const we = window as any;
    if (we.__aitiEditor) Object.assign(we.__aitiEditor, { hasFileFace, openFileFace, dockFile, closeFileFace, openImagePreview });
  } catch { /* noop */ }

  warmMonacoOnIdle();

  // 就绪广播（开页方案 §1 F5）：本扩展物化完成。消费方（aiti-git-review 的 👁 动作晚注册）
  // 监听它挂接开放点，替代「消费方 ensureMaterialized 反向拉起」——后者会把 editor 连同
  // monaco 预热在审查场景里提前拽起。register 幂等路径（__aitiEditor 已存在）同样广播。
  try { window.dispatchEvent(new CustomEvent("aiti-editor:ready")); } catch { /* noop */ }
}

// ── Monaco 后台预热（首次交互后空闲才拉）──
// 整条 Monaco AMD 链（loader → editor.main → 依赖分包，~30 请求 / ~1.1MB gzip）。历史实现
// 是“register 一跑就 rIC 预热”，后果：每次开页（editor 被 git-review / rightFileDock 拉起时）
// 静默拉 ~4.5MB 解码/1.17MB gzip，与本扩展是否被用户使用无关。现改为：
//   · 用户首次 pointerdown/keydown 之后的空闲窗口才预热（点开文件前通常已有交互，仍近零等待）；
//   · 同 tab 内已开过文件（sessionStorage 标记，editor-app 写入）→ 直接空闲预热；
//   · 无交互直接开文件 → 回落现场加载（loadMonaco 自带退避重试）。
// 安全性不变：loadMonaco 幂等（模块级 promise + loader 握手 + window.monaco 复用），
// 与 aiti-git-review 共享同一实例不双载；预热失败静默；Data Saver 跳过。
// 参见 docs/pi-web-load-perf-optimization-plan.md §3。
const EDITOR_OPENED_KEY = "aiti-editor:opened";
let monacoWarmStarted = false;
function warmMonacoOnIdle(): void {
  if (monacoWarmStarted) return;
  monacoWarmStarted = true;
  try {
    const conn = (navigator as any).connection;
    if (conn && conn.saveData) return;
    const kick = () => {
      // 连接池保护：媒体（<video>/<audio>）加载中先让路——HTTP/1.1 每主机仅 6 条连接，
      // monaco 3.9MB 预热与媒体流同抢会双双饿死（实测视频永久 pending）。纯优化，可无限顺延。
      if (document.querySelector("video[src], audio[src]")) { setTimeout(kick, 5000); return; }
      loadMonaco().catch(() => { /* 预热失败不打扰 */ });
    };
    const idle = () => {
      const ric = (window as any).requestIdleCallback;
      if (typeof ric === "function") ric(kick, { timeout: 8000 });
      else setTimeout(kick, 3000);
    };
    let alreadyOpened = false;
    try { alreadyOpened = sessionStorage.getItem(EDITOR_OPENED_KEY) === "1"; } catch { /* noop */ }
    if (alreadyOpened) { idle(); return; }
    window.addEventListener("pointerdown", idle, { once: true, passive: true });
    window.addEventListener("keydown", idle, { once: true, passive: true });
  } catch { /* 预热属纯优化，任何异常不影响编辑器注册 */ }
}

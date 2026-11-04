/**
 * aiti-git-review · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配（与旧手写版注册时序一致）：
 *   - toolbar 👁️ 按钮 + pages 全页审核工作区
 *   - aiti-editor 文件工具条开放点（👁️ 审此文件——2026-08-30 起收入编辑器 ⋯ 更多菜单）
 *   - aiti-folder 目录工具条开放点（👁️ 审此目录）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 */
import { __setCtx, apiUrl } from "./host-shim";
import { seedDockDefault } from "../../../_shared/ext-float-dock";
import { api, G, setGRCtx } from "./shared";
import { openFromToolbar, ReviewWork, DockReviewWork, GrEyeIcon } from "./git-review-app";

export default function register(ctx: Record<string, any>) {
  // v3 §2-B：播种默认落位（用户无偏好时首次 open 直达右栏；⇲/选浮窗后永不覆盖）
  seedDockDefault("aiti-git-review:workspace", "right-panel");
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);
  setGRCtx(ctx);

  // 懒加载 v2 M3批②：声明式条目（无 render）
  ctx.registerItems?.("toolbar", [{
    id: "aiti-git-review-open",
    meta: {
      label: "审核",
      title: "aiti-git-review：审核变更（未提交 / 指定基线 / 两版本对比）",
      icon: "icons/eye.svg",
      onClick: () => openFromToolbar(),
    },
  }]);
  ctx.registerItems?.("pages", [{ id: "aiti-git-review-page", render: ReviewWork }]);
  // aiti-float dock v0.5.0（§1.1 审查 tab）：右栏停靠 face——与 pages face 经状态机互斥 gate
  // ⚠ 注册 raw itemId，宿主自动拼 extId:itemId = itemKey——必须与状态机 key "aiti-git-review:workspace" 一致
  ctx.registerItems?.("rightFileDock", [{ id: "workspace", render: DockReviewWork, meta: { title: "审查" } }]);

  // ── 全局打开兜底（ReviewWork 挂载前的早期调用只记状态） ──
  (window as any).__aitiGitReviewOpen = (opts: any) => { G.open = opts || {}; };
  // DI 方案 P2：services 通道双轨注册（旧全局保留；旧宿主 no-op）
  try { ctx.registerExtService?.("aiti-git-review.open", (window as any).__aitiGitReviewOpen); } catch {}

  // [懒加载 v2 + 开页方案 §1 F5] editor/folder 可能尚未物化（双方懒加载后 materialize 无固定
  // 顺序），registerFileAction/FolderAction 依赖对方的 __aitiEditor/__aitiFolder 全局。原实现
  // 在 register 里 ensureMaterialized 反向拉起对方——副作用：用户只是点开「审查」dock tab，
  // editor（连其 monaco 预热）与 folder 就被拽起。改为「对方就绪事件」驱动的晚注册：在场即挂
  // （原行为），不在场等 aiti-editor:ready / aiti-folder:ready 广播（editor/folder 各自
  // register 末尾派发）；注册经可变槽位捕获，注销路径同样覆盖晚注册的动作。
  let unregEditor: null | (() => void) = registerFileAction();
  let unregFolder: null | (() => void) = registerFolderAction();
  const onEditorReady = () => { if (!unregEditor) { try { unregEditor = registerFileAction(); } catch { /* noop */ } } };
  const onFolderReady = () => { if (!unregFolder) { try { unregFolder = registerFolderAction(); } catch { /* noop */ } } };
  window.addEventListener("aiti-editor:ready", onEditorReady);
  window.addEventListener("aiti-folder:ready", onFolderReady);
  (window as any).__aitiGitReviewUnreg = () => {
    try { unregEditor && unregEditor(); } catch {}
    try { unregFolder && unregFolder(); } catch {}
    try { window.removeEventListener("aiti-editor:ready", onEditorReady); } catch { /* noop */ }
    try { window.removeEventListener("aiti-folder:ready", onFolderReady); } catch { /* noop */ }
  };
  try { console.log("[aiti-git-review] client M3 已挂载（标注/汇总/发送/跳转）"); } catch {}

  // Monaco 不再空闲预热：首次访问/缓存过期时预热 = 1MB+ 网络 + 5 个 worker，
  // 与页面加载抢带宽（资产端点慢时单文件 15-20s）；审核是低频操作，
  // 改为打开审核时现场加载（loader 链自带重试）。

  return () => {
    try { (window as any).__aitiGitReviewUnreg && (window as any).__aitiGitReviewUnreg(); } catch {}
    try { delete (window as any).__aitiGitReviewWork; } catch {}
  };
}

// ── 文件工具条按钮（aiti-editor bar 开放点） ──
function registerFileAction(): null | (() => void) {
  try {
    return (window as any).__aitiEditor && (window as any).__aitiEditor.registerAction
      ? (window as any).__aitiEditor.registerAction({
          id: "aiti-git-review-file",
          label: "👁️",
          icon: <GrEyeIcon size={13} />, // 统一眼图标：编辑器 ⋯ 菜单项随 icon 渲染（label 纯 emoji 时菜单文案回退 title）
          title: "审此文件（未提交变更）",
          match: (fp: string) => !!fp,
          onClick: (fp: string) => {
            const base = String(fp).split("/").slice(0, -1).join("/") || "/";
            api("/hasChanges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: fp, base }) }).then((r) => r.json()).then((d) => {
              if ((d as any) && (d as any).hasChanges) {
                G.open = { path: fp, scope: { kind: "file", path: fp } };
              } else {
                // 该文件无未提交变更 → 仍开选择器（预设目录），可切「两版本/指定基线」审历史
                G.presetRepo = base;
                G.open = { scope: { kind: "dir", path: base } };
              }
              try { (window as any).__aitiGitReviewWork(); } catch {}
            }).catch(() => {});
          },
        })
      : null;
  } catch { return null; }
}

// ── 目录级入口（aiti-folder 工具条开放点）：仅该目录下有未提交变更时显示；点击带目录预设开选择器 ──
function registerFolderAction(): null | (() => void) {
  try {
    return (window as any).__aitiFolder && (window as any).__aitiFolder.registerAction
      ? (window as any).__aitiFolder.registerAction({
          id: "aiti-git-review-dir",
          label: "👁️",
          icon: <GrEyeIcon size={13} />, // 统一眼图标：目录工具条按钮随 icon 渲染（不再用 emoji 字符）
          title: "审此目录（未提交变更）",
          match: (_dir: string, ctx2: any) => (ctx2 && ctx2.gitFiles ? ctx2.gitFiles.length > 0 : true),
          onClick: (dir: string) => {
            G.presetRepo = dir;
            G.open = { scope: { kind: "dir", path: dir } };
            try { (window as any).__aitiGitReviewOpen(G.open); } catch {}
            try { (window as any).__aitiGitReviewWork(); } catch {}
          },
        })
      : null;
  } catch { return null; }
}

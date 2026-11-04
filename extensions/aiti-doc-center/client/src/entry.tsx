/**
 * entry.tsx —— aiti-doc-center client 入口（JSX 版）
 *
 * 插槽：toolbar（📚 文档按钮入口）+ pages（弹窗面板，data-ext-float 规范）。
 * 委托入口：window.__aitiDocCenterOpen() —— 其他扩展可调起。
 */
import { __setCtx } from "./host-shim";
import { seedDockDefault } from "../../../_shared/ext-float-dock";
import { DocCenterPageSlot, DockDocs } from "./doc-center-app";
import { registerEditorFileTags } from "./file-tags";

const OPEN_EVENT = "aiti-doc-center:open";
function requestOpen() {
  try { window.dispatchEvent(new CustomEvent(OPEN_EVENT)); } catch { /* 忽略 */ }
}

export default function register(ctx: Record<string, any>) {
  // v3 §2-B：播种默认落位（用户无偏好时首次 open 直达右栏；⇲/选浮窗后永不覆盖）
  seedDockDefault("aiti-doc-center:docs", "right-panel");
  __setCtx(ctx); // 必须在任何 JSX 渲染前

  (window as any).__aitiDocCenterOpen = () => requestOpen();

  function ToolbarButton() {
    return (
      <button type="button" title="文档中心：workspace 文档收集与全文检索" onClick={() => requestOpen()}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", borderTop: "none", borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}>
        {/* lucide book-open 线图（系统同风格） */}
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 7v14" />
          <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
        </svg>
      </button>
    );
  }

  // 懒加载 v2 两段式：声明式条目（无 render）——宿主渲染静态按钮，点击经转发器到本 onClick
  ctx.registerItems?.("toolbar", [{
    id: "aiti-doc-center-open",
    meta: {
      label: "文档",
      title: "文档中心：workspace 文档收集与全文检索",
      icon: { svg: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>' },
      onClick: () => requestOpen(),
    },
  }]);
  ctx.registerItems?.("pages", [{ id: "aiti-doc-center-page", render: DocCenterPageSlot, meta: { label: "文档中心" } }]);
  // aiti-float dock v0.5.x（§1.1 文档 tab）：右栏停靠 face——与 pages 浮窗经状态机互斥 gate
  // ⚠ 注册 raw itemId，宿主自动拼 extId:itemId = itemKey——必须与状态机 key "aiti-doc-center:docs" 的
  // itemId 段一致（拼后链路：镜像/联动/TabBody only 全按复合 id 匹配）
  ctx.registerItems?.("rightFileDock", [{ id: "docs", render: DockDocs, meta: { title: "文档" } }]);
  // M6-B 编辑器联动：aiti-editor ⋯ 菜单「🏷 标签」入口（查看/增删任意文件 tag；非 md 打 tag 即进索引）
  const unregTags = registerEditorFileTags();
  if (unregTags) { try { (ctx as any).registerCleanup?.(unregTags); } catch { /* 旧宿主无此口：模块随页面生命周期 */ } }
  try { console.log("[aiti-doc-center] 弹窗已挂载（toolbar 📚 入口 → pages 弹窗）"); } catch { /* noop */ }
}

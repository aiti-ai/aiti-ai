/**
 * amw-styles · aiti-model-wizard 自持样式层（阶段 A）
 *
 * 设计决策（docs/aiti-model-wizard-refactor-plan.md §阶段 A）：
 * - 命名空间：全部类名 `amw-` 前缀，与宿主（pi-web）及任何页面零碰撞
 * - 范式对标：取值复刻 pi-web `app/settings.css`（config-* 系列）的设计语言——
 *   面板 8px 圆角 / 侧栏 240px / 条目高 30px / 按钮 5px 圆角 + .14s 过渡 /
 *   focus-visible 2px 描边等；实现完全自有，宿主改版不受影响
 * - 主题跟随：设计令牌一律 `var(--x, 兜底)` 弱引用宿主 CSS 变量——
 *   在 pi-web 内自动跟随亮暗主题；脱离宿主时兜底值生效照常可用。
 *   依赖方向单向：宿主改变量名最坏退化为兜底色，不会碎
 * - 字体：不设 font-family（继承宿主）；仅设字号/行高
 * - 交付：STYLES 字符串 + ensureStyles() 幂等注入 <style>（vite lib mode 单文件契约，
 *   不走 vite CSS 资产分包）；entry.tsx register() 首行调用一次
 */

export const STYLES = `
/* ===== 外壳（浮动面板；aiti-float 未接管时的回退锚定） ===== */
.amw-shell {
  position: fixed; right: 18px; bottom: 70px;
  width: 960px; max-width: 94vw;
  max-height: calc(100dvh - 96px); min-height: 60dvh;
  display: flex; flex-direction: column;
  z-index: 2147483101;
  background: var(--bg, #fff); color: var(--text, #1a1a1a);
  border: 1px solid var(--border, #e0e0e0); border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  font-size: 13px; line-height: 1.5;
}

/* dock v3 停靠 face（data-amw-embedded，由 App embedded prop 标注）：铺满 DockBody 容器，
   剥浮窗锚定/悬浮视觉——停靠内容禁 float 增强（无 data-ext-float 属性），不受 !important 接管 */
.amw-shell[data-amw-embedded="1"] {
  position: relative; right: auto; bottom: auto; z-index: auto;
  width: 100%; max-width: none; height: 100%; flex: 1;
  max-height: none; min-height: 0;
  border-radius: 0; border: none; box-shadow: none;
}

/* ===== 头部 / 页签 / 内容体 ===== */
.amw-header {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex-shrink: 0;
  min-height: 46px; padding: 8px 14px 8px 16px;
  border-bottom: 1px solid var(--border, #e0e0e0);
  container-type: inline-size; /* 工具条随面板宽度收缩（aiti-float 拖窄也能响应）；头部无 fixed 后代，无包含块副作用 */
}
.amw-title {
  display: flex; align-items: center; gap: 6px;
  color: var(--text, #1a1a1a); font-size: 14px; font-weight: 600;
}
/* 页签切换（大屏主导航；窄容器自动折行——学 aiti-usage：右侧动作 marginLeft:auto 靠右） */
.amw-tabs { display: flex; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.amw-tabs::-webkit-scrollbar { display: none; }
.amw-tab {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 11px; border: 0; border-radius: 5px; cursor: pointer;
  background: transparent; color: var(--text-muted, #5f6b7a);
  font-family: inherit; font-size: 12px; white-space: nowrap;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.amw-tab:not(:disabled):hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); }
.amw-tab.is-on { background: var(--accent, #2563eb); color: #fff; font-weight: 600; }
.amw-tab:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: -2px; }
.amw-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; }
.amw-close {
  display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 5px; background: transparent;
  color: var(--text-muted, #5f6b7a); cursor: pointer; flex-shrink: 0;
}
.amw-close:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); color: var(--text, #1a1a1a); }
/* 头部工具条标签降级梯度（约定）：通用符号（＋/☰/✕）可只剩图标；文字按钮按空间 4字→2字保持可读，纯图标是最后手段 */
.amw-tb-btn { flex-shrink: 1; min-width: 0; }
/* ===== 头部功能菜单（辅助操作弹出） ===== */
.amw-menu {
  position: absolute; right: 0; top: calc(100% + 6px);
  min-width: 240px; padding: 5px; z-index: 30;
  background: var(--bg, #fff); border: 1px solid var(--border, #e0e0e0);
  border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
}
.amw-menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 9px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text, #1a1a1a);
  cursor: pointer; font-family: inherit; font-size: 12.5px; text-align: left;
}
.amw-menu-item:hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); }
.amw-menu-item:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: -2px; }
.amw-menu-hint { flex-shrink: 0; color: var(--text-dim, #9ca3af); font-size: 10.5px; }
.amw-menu-sep { height: 1px; margin: 4px 6px; background: var(--border, #e0e0e0); }
/* ≤620px：只藏标题文字（4字）；「功能」2字标签保留 */
@container (max-width: 620px) {
  .amw-title-text { display: none; }
}
/* ≤860px：主色添加按钮的长尾「 provider」收起（＋添加 2字仍可读） */
@container (max-width: 860px) {
  .amw-label-long { display: none; }
}
/* ≤700px：页签收紧字体留空隙（可横滑，不隐藏——用户要在小屏看到/点到每个 tab） */
@container (max-width: 700px) {
  .amw-tab { padding: 4px 8px; font-size: 11px; }
}
/* ≤430px：空间极端紧张，「功能」才退为纯 ☰ 图标（最后手段） */
@container (max-width: 430px) {
  .amw-tb-label { display: none; }
  .amw-tb-btn { padding: 4px 7px; }
}

/* ===== 按钮（对标 config-button：5px 圆角 + .14s 过渡 + focus 环 + disabled 半透明） ===== */
.amw-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  white-space: nowrap; flex-shrink: 0; padding: 4px 11px;
  border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: var(--bg, #fff); color: var(--text-muted, #374151);
  font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.4;
  cursor: pointer;
  transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.amw-btn:not(:disabled):hover { background: var(--bg-hover, rgba(0, 0, 0, 0.04)); color: var(--text, #1a1a1a); }
.amw-btn:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: 2px; }
.amw-btn:disabled { cursor: default; opacity: 0.5; }
.amw-btn.is-primary { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; font-weight: 600; }
.amw-btn.is-primary:not(:disabled):hover {
  background: color-mix(in srgb, var(--accent, #2563eb) 88%, #000);
  border-color: color-mix(in srgb, var(--accent, #2563eb) 88%, #000); color: #fff;
}
.amw-btn.is-ok { background: #16a34a; border-color: #16a34a; color: #fff; font-weight: 600; }
.amw-btn.is-ok:not(:disabled):hover { background: #15803d; border-color: #15803d; }
.amw-btn.is-danger { background: rgba(239, 68, 68, 0.06); border-color: rgba(239, 68, 68, 0.35); color: var(--danger, #ef4444); }
.amw-btn.is-danger:not(:disabled):hover { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.5); }

/* ===== 输入（对标 ModelsConfig inputStyle：panel 底 + border + 5px 圆角） ===== */
.amw-input {
  padding: 6px 9px; border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: var(--bg-panel, #fff); color: var(--text, #1a1a1a);
  font-family: inherit; font-size: 13px; line-height: 1.5;
  outline: none; box-sizing: border-box;
}
.amw-input::placeholder { color: var(--text-dim, #9ca3af); }
.amw-input:focus { border-color: var(--accent, #2563eb); }
.amw-select {
  padding: 6px 9px; border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: var(--bg-panel, #fff); color: var(--text, #1a1a1a);
  font-family: inherit; font-size: 12px; outline: none; cursor: pointer;
}
.amw-check {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  color: var(--text-muted, #5f6b7a); font-size: 12px; font-family: inherit;
}
.amw-check > input { width: 13px; height: 13px; accent-color: var(--accent, #2563eb); cursor: pointer; }

/* ===== 文本原语 ===== */
.amw-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; word-break: break-all; }
.amw-link { color: var(--accent, #2563eb); text-decoration: underline; cursor: pointer; word-break: break-all; }
.amw-section {
  display: flex; align-items: center; gap: 6px;
  color: var(--text-dim, #6b7280); font-size: 11px; font-weight: 600;
  letter-spacing: 0; text-transform: uppercase;
  margin: 10px 0 6px;
}
.amw-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.amw-field-label { color: var(--text-muted, #5f6b7a); font-size: 11px; font-weight: 500; line-height: 1.35; }

/* ===== 提示条（原 mk.m/ok/w/e → amw-note + 变体） ===== */
.amw-note {
  padding: 6px 10px; margin-bottom: 8px;
  border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: var(--bg-panel, #f5f5f5); color: var(--text-muted, #374151);
  font-size: 12px; line-height: 1.5;
}
.amw-note.is-ok { background: rgba(34, 197, 94, 0.12); border-color: rgba(34, 197, 94, 0.35); color: #16a34a; }
.amw-note.is-warn { background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.35); color: #b45309; }
.amw-note.is-err { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.3); color: #dc2626; }

/* ===== 标签 / 徽标 / 芯片 ===== */
.amw-tag {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 7px; border-radius: 999px; border: 1px solid transparent;
  font-size: 11px; font-weight: 650; white-space: nowrap;
}
.amw-tag.is-combo { background: rgba(217, 119, 6, 0.14); color: #d97706; border-color: rgba(217, 119, 6, 0.35); }
.amw-tag.is-oauth { background: rgba(99, 102, 241, 0.14); color: #4f46e5; border-color: rgba(99, 102, 241, 0.35); }
.amw-tag.is-new { background: rgba(34, 197, 94, 0.14); color: #15803d; border-color: rgba(34, 197, 94, 0.35); }
.amw-tag.is-ro { background: rgba(99, 102, 241, 0.14); color: #4f46e5; border-color: rgba(99, 102, 241, 0.35); }
.amw-chip {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 0 5px; border-radius: 4px;
  font-size: 11px; line-height: 16px; white-space: nowrap;
}
.amw-chip.is-key { background: rgba(37, 99, 235, 0.10); color: var(--accent, #2563eb); }
.amw-chip.is-combo { background: rgba(217, 119, 6, 0.14); color: #d97706; }
.amw-chip.is-ok { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.amw-chip.is-warn { background: rgba(245, 158, 11, 0.16); color: #b45309; }
.amw-chip.is-err { background: rgba(239, 68, 68, 0.14); color: #dc2626; }
.amw-pill {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 8px; border-radius: 999px;
  background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.25);
  font-size: 11px; font-weight: 600; color: #4f46e5;
}
.amw-dot { display: inline-block; width: 6px; height: 6px; border-radius: 3px; background: #16a34a; flex-shrink: 0; }
/* 可用性徽标（模型树）：颜色由内联给定，形状/尺寸统一 */
.amw-vdot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

/* ===== 卡片 / 行 ===== */
.amw-card {
  border: 1px solid var(--border, #e0e0e0); border-radius: 8px;
  padding: 8px; margin-bottom: 6px; cursor: pointer; background: var(--bg, #fff);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.amw-card.is-on { border-color: var(--accent, #2563eb); box-shadow: 0 0 0 1px var(--accent, #2563eb); }
.amw-card:not(.is-on):hover { border-color: rgba(99, 102, 241, 0.5); box-shadow: 0 3px 12px rgba(99, 102, 241, 0.16); }
.amw-row {
  padding: 7px 8px; border-bottom: 1px solid var(--border, #e0e0e0);
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}

/* ===== 浮层（二次弹窗遮罩 + 面板） ===== */
.amw-overlay {
  position: fixed; inset: 0; z-index: 2147483190;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.35); padding: 16px;
}
.amw-overlay-top { z-index: 2147483196; background: rgba(15, 23, 42, 0.42); padding: 18px; font-size: 13px; line-height: 1.5; }
.amw-float-panel {
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg, #fff); color: var(--text, #1a1a1a);
  border: 1px solid var(--border, #e0e0e0); border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
}
.amw-dialog-head {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  padding: 4px 0 8px; border-bottom: 1px solid var(--border, #e0e0e0);
}
.amw-dialog-body { overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.amw-dialog-foot { display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding-top: 10px; }

/* ===== 步骤头（数字徽标 + 标题 + 提示） ===== */
.amw-step { display: flex; align-items: center; gap: 7px; margin: 16px 0 8px; min-height: 24px; }
.amw-step-dot {
  width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent, #2563eb); color: #fff; font-size: 11px; font-weight: 700;
}
.amw-step-title { font-size: 13px; font-weight: 700; flex-shrink: 0; color: var(--text, #1a1a1a); }
.amw-step-hint { color: var(--text-dim, #9ca3af); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ===== 品牌头像 ===== */
.amw-avatar {
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden;
  background: var(--bg, #fff); border: 1px solid var(--border, #e5e5e5);
}
.amw-avatar.is-fallback {
  background: linear-gradient(135deg, #6366f1, #a855f7); border: none; color: #fff; font-weight: 700;
}

/* ===== B 阶段：双栏容器（桌面固定高，内部各自滚动；小屏由媒体查询接管为弹性填充） ===== */
.amw-split-box {
  display: flex; overflow: hidden;
  height: min(60dvh, 620px); min-height: 380px;
  border: 1px solid var(--border, #e0e0e0); border-radius: 8px; background: var(--bg, #fff);
}

/* ===== B 阶段：双栏（对标 config-split-view / config-sidebar / config-detail） ===== */
.amw-split { display: flex; flex: 1; flex-direction: row; min-height: 0; overflow: hidden; }
.amw-sidebar {
  display: flex; flex-direction: column; flex-shrink: 0; width: 280px; min-height: 0;
  border-right: 1px solid var(--border, #e0e0e0); background: var(--bg-panel, #fafafa);
}
.amw-sidebar-list { flex: 1; min-height: 0; padding: 8px 6px; overflow-y: auto; }
.amw-sidebar-search { flex-shrink: 0; padding: 8px 8px 4px; }
.amw-group-label {
  padding: 4px 8px 3px; color: var(--text-dim, #6b7280);
  font-size: 11px; font-weight: 600; line-height: 1.4; text-transform: uppercase;
}
.amw-sb-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 34px;
  padding: 0 8px; border: 0; border-radius: 5px; outline: none;
  background: transparent; color: var(--text, #1a1a1a); cursor: pointer;
  font-family: inherit; font-size: 14px; text-align: left;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.amw-sb-item:not(:disabled):hover { background: var(--bg-hover, rgba(0, 0, 0, 0.05)); }
.amw-sb-item:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: -2px; }
.amw-sb-item[aria-current="page"] { background: var(--bg-selected, rgba(37, 99, 235, 0.12)); font-weight: 600; }
.amw-sb-item:disabled { cursor: default; opacity: 0.5; }
.amw-sb-item.is-indent { padding-left: 26px; }
.amw-sb-item.is-add { color: var(--text-dim, #6b7280); }
.amw-sb-item.is-add:not(:disabled):hover { color: var(--accent, #2563eb); }
.amw-sb-text { display: block; min-width: 0; overflow: hidden; font-size: 14px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.amw-sb-text.is-grow { flex: 1; }
.amw-detail { flex: 1; min-width: 0; min-height: 0; padding: 16px 18px; overflow-y: auto; font-size: 13px; line-height: 1.5; }
.amw-detail-stack { display: flex; flex-direction: column; gap: 16px; width: 100%; min-width: 0; }
.amw-detail-title { color: var(--text, #1a1a1a); font-size: 14px; font-weight: 600; line-height: 1.35; }
.amw-empty {
  display: grid; place-items: center; flex: 1; min-height: 160px;
  color: var(--text-dim, #6b7280); font-size: 12px; text-align: center;
}
.amw-footer {
  display: flex; flex-shrink: 0; align-items: center; gap: 8px; min-height: 48px;
  padding: 8px 14px; border-top: 1px solid var(--border, #e0e0e0);
}
.amw-footer-status { flex: 1; min-width: 0; overflow: hidden; color: var(--text-dim, #6b7280); font-size: 11px; }
.amw-footer-actions { display: flex; flex-shrink: 0; align-items: center; justify-content: flex-end; gap: 8px; }

/* ===== 多 key / 聚合运行状态（multi-key-status 专用） ===== */
.amw-st-rows { min-width: 0; border-top: 1px solid var(--border, #e0e0e0); margin-top: 4px; padding-top: 10px; }
.amw-st-head-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.amw-st-block { margin-top: 6px; min-width: 0; }
.amw-st-head { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--text, #1a1a1a); margin-bottom: 3px; }
.amw-st-sub { color: var(--text-dim, #6b7280); font-weight: 400; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.amw-st-grid { display: grid; grid-template-columns: max-content max-content; column-gap: 14px; row-gap: 3px; justify-content: start; }
.amw-st-slot { color: var(--text-dim, #6b7280); white-space: nowrap; display: flex; gap: 4px; align-items: center; min-width: 0; }
.amw-st-slot.is-cur { color: var(--accent, #2563eb); }
.amw-st-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.amw-st-stats { color: var(--text-muted, #5f6b7a); white-space: nowrap; font-size: 10.5px; min-width: 0; }
/* 会话信息下拉条目：不自带纵向滚动（去掉旧 260px 限高）——高度自然展开，
   由宿主会话信息面板的整体滚动条统一滚动（大小屏同一条）；仅保留横向收容。 */
.amw-st-scroll { overflow-x: auto; overscroll-behavior-x: contain; padding-right: 8px; margin-right: -8px; container-type: inline-size; container-name: amwst; }
.amw-st-legend { padding: 7px 14px; border-top: 1px solid var(--border, #e0e0e0); font-size: 10.5px; color: var(--text-dim, #6b7280); }
.amw-refresh {
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  cursor: pointer; border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: transparent; color: var(--text-dim, #6b7280); flex: 0 0 auto;
}
.amw-refresh:hover { color: var(--accent, #2563eb); }
.amw-sum-chip {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex-shrink: 0;
  padding: 3px 9px; border: 1px solid var(--border, #e0e0e0); border-radius: 999px;
  cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 600;
}

/* ===== 小工具 ===== */
.amw-hint { color: var(--text-muted, #5f6b7a); font-size: 10.5px; }
.amw-hint-lg { color: var(--text-muted, #5f6b7a); font-size: 13px; line-height: 1.5; }
.amw-st-dlg-head {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  padding: 11px 14px; border-bottom: 1px solid var(--border, #e0e0e0);
  background: var(--bg-subtle, transparent);
}
.amw-st-dlg-body { overflow-y: auto; overflow-x: auto; overscroll-behavior-x: contain; padding: 6px 14px 12px; flex: 1; min-height: 0; container-type: inline-size; container-name: amwst; }
/* 运行状态槽位标识：宽容器完整显示 key（大屏不截断），仅窄容器截断 + title tooltip 兑底 */
@container amwst (max-width: 560px) {
  .amw-st-label { max-width: 46cqw; }
}

/* ===== 小屏适配（镜像 aiti-float FULL_MQ ≤640px 宽）：默认真全屏，零视口算术 =====
   有 aiti-float 时其内联 !important 全屏样式与这里同值双保险；无 aiti-float 宿主由此兑底。 */
@media (max-width: 640px) {
  .amw-shell {
    left: 0; top: 0; right: 0; bottom: 0;
    width: 100%; height: 100%;
    max-width: none; max-height: none; min-height: 0;
    border-radius: 0; border: none; box-shadow: none;
  }
  /* 内容体可纵向滚动（非双栏视图如 添加/聚合 整页能滚到底）；双栏 split-box 则 flex:1 占满可用高 */
  .amw-body { overflow-y: auto; display: flex; flex-direction: column; padding: 10px; }
  .amw-split-box { flex: 1; min-height: 40dvh; border: none; border-radius: 0; }
  .amw-split-box .amw-sidebar { width: 100%; border-right: none; }
  /* 浮层同样全屏（压过面板内联 min(780px,94vw)/84dvh 等） */
  .amw-overlay { padding: 0; }
  .amw-overlay .amw-float-panel {
    width: 100% !important;
    height: 100%;
    max-height: none !important;
    border-radius: 0; border: none;
  }
  .amw-st-dlg-head { padding-top: max(11px, env(safe-area-inset-top, 0px)); }
}
/* 无 container query 支持的老浏览器兜底：极窄视口同样藏标签 */
@media (max-width: 430px) {
  .amw-title-text, .amw-tb-label { display: none; }
  .amw-tb-btn { padding: 4px 7px; }
  /* 运行状态行：极窄视口收窄槽位名列（ellipsis），统计链更早入画，余下内容横向滚动可达 */
  .amw-st-label { max-width: 40vw; }
}
`;

/** 幂等注入：<style id> 防重复；多次 register / 多副本加载安全。 */
export function ensureStyles(): void {
  if (typeof document === "undefined") return;
  const ID = "aiti-model-wizard-styles";
  if (document.getElementById(ID)) return;
  const el = document.createElement("style");
  el.id = ID;
  el.textContent = STYLES;
  document.head.appendChild(el);
}

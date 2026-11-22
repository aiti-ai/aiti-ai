/**
 * agent-manager-styles — aiti-agent-manager 自持样式层（零构建，am- 前缀）。
 *
 * 设计语言复刻 pi-web `app/settings.css` 的 config-button 系列：
 * 5px 圆角 / .14s 过渡 / primary|secondary|danger|ghost 四态 / focus-visible 描边 /
 * disabled 0.5 透明度；主题跟随 `var(--x, 兜底)` 弱引用宿主令牌（亮/暗/主题色自动适配）。
 * ensureStyles() 幂等注入 <style>（多次 register / 多副本加载安全）。
 */

export const STYLES = `
/* ===== 面板外壳（aiti-float 未接管时的回退锚定；接管后由属性驱动覆盖） ===== */
.am-panel {
  position: fixed; top: 8%; right: 3%; z-index: 9999;
  width: 560px; max-width: 94vw;
  display: flex; flex-direction: column;
  max-height: 78vh;
  background: var(--bg, #fff); color: var(--text, #1a1a1a);
  border: 1px solid var(--border, #e0e0e0); border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, .28);
  font-size: 13px; line-height: 1.5;
}
.am-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px 9px;
  border-bottom: 1px solid var(--border, #e0e0e0);
  flex-shrink: 0;
}
.am-title { font-weight: 600; font-size: 13px; }
.am-head-sub { font-size: 11px; color: var(--text-dim, #5e6673); }
.am-spacer { flex: 1; }
.am-body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 14px 12px; }

/* ===== 提示条（操作结果 / 错误） ===== */
.am-notice, .am-error {
  margin: 8px 0 2px; padding: 6px 10px; border-radius: 6px;
  font-size: 12px; line-height: 17px; white-space: pre-wrap;
}
.am-notice { background: rgba(22, 163, 74, .08); border: 1px solid rgba(22, 163, 74, .28); color: #16a34a; }
.am-error  { background: rgba(220, 38, 38, .07); border: 1px solid rgba(220, 38, 38, .28); color: #dc2626; }

/* ===== agent 行 ===== */
.am-row { padding: 10px 0; border-top: 1px solid var(--border, #e0e0e0); }
.am-row:first-child { border-top: 0; }
.am-row-head { display: flex; align-items: center; gap: 8px; }
.am-name { font-weight: 600; font-size: 13px; }
.am-badge { font-size: 12px; font-weight: 600; white-space: nowrap; }
.am-badge.is-ready { color: #16a34a; }
.am-badge.is-missing { color: #d97706; }
.am-badge.is-unknown { color: var(--text-dim, #5e6673); }
.am-badge.is-logging { color: var(--accent, #245bce); }
.am-flag { font-size: 11px; color: var(--text-dim, #5e6673); }
.am-meta {
  margin: 3px 0 8px; font-size: 11px; line-height: 16px;
  color: var(--text-muted, #515c6b);
}
.am-acct-line { font-size: 11px; line-height: 16px; margin: 0 0 8px; }
.am-acct-line.is-ok { color: #16a34a; }
.am-acct-line.is-warn { color: #d97706; }

/* ===== 操作条（分组换行；账号组右对齐） ===== */
.am-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.am-actions + .am-actions { margin-top: 6px; }
.am-actions.is-end { justify-content: flex-end; }
.am-inline { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }

/* ===== 按钮（config-button 设计语言：primary / danger / ghost / small / disabled） ===== */
.am-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 26px; padding: 0 10px;
  font-family: inherit; font-size: 12px; line-height: 1; letter-spacing: 0;
  border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: transparent; color: var(--text-muted, #515c6b);
  cursor: pointer; white-space: nowrap;
  transition: background-color .14s ease, border-color .14s ease, color .14s ease;
}
.am-btn:not(:disabled):hover { background: var(--bg-hover, #eeeeee); color: var(--text, #1a1a1a); }
.am-btn:focus-visible { outline: 2px solid var(--accent, #245bce); outline-offset: 2px; }
.am-btn:disabled { opacity: .5; cursor: default; }
.am-btn.is-primary {
  border-color: var(--accent, #245bce); background: var(--accent, #245bce);
  color: var(--accent-contrast, #fff); font-weight: 600;
}
.am-btn.is-primary:not(:disabled):hover { border-color: var(--accent-hover, #1d4ed8); background: var(--accent-hover, #1d4ed8); color: var(--accent-contrast, #fff); }
.am-btn.is-danger { border-color: color-mix(in srgb, var(--danger, #ef4444) 35%, transparent); background: color-mix(in srgb, var(--danger, #ef4444) 6%, transparent); color: var(--danger, #ef4444); }
.am-btn.is-danger:not(:disabled):hover { border-color: color-mix(in srgb, var(--danger, #ef4444) 50%, transparent); background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent); }
.am-btn.is-ghost { border-color: transparent; background: transparent; }
.am-btn.is-sm { height: 22px; padding: 0 8px; font-size: 11px; }

/* ===== 输入框 ===== */
.am-input {
  flex: 1; min-width: 0; height: 26px; padding: 0 8px;
  font-family: inherit; font-size: 12px;
  border: 1px solid var(--border, #e0e0e0); border-radius: 5px;
  background: var(--bg, #fff); color: inherit;
}
.am-input:focus-visible { outline: none; border-color: var(--accent, #245bce); box-shadow: 0 0 0 2px rgba(36, 91, 206, .18); }
.am-input::placeholder { color: var(--text-dim, #5e6673); opacity: .85; }

/* ===== 账号档卡片 ===== */
.am-accounts {
  margin-top: 8px; padding: 10px 12px; display: grid; gap: 8px;
  background: var(--bg-subtle, rgba(0, 0, 0, .03));
  border: 1px solid var(--border, #e0e0e0); border-radius: 8px;
}
.am-accounts-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.am-hint { font-size: 11px; line-height: 17px; color: var(--text-muted, #515c6b); }
.am-save-row { display: flex; gap: 6px; }
.am-acc-list { display: grid; gap: 4px; }
.am-acc-item {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px; border-radius: 6px; border: 1px solid transparent;
}
.am-acc-item:hover { background: var(--bg-hover, #eeeeee); }
.am-acc-item.is-current { border-color: rgba(22, 163, 74, .35); background: rgba(22, 163, 74, .06); }
.am-acc-label { font-size: 12px; font-weight: 600; white-space: nowrap; }
.am-acc-label.is-auto { font-weight: 500; color: var(--text-dim, #5e6673); }
.am-acc-chip {
  font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--border, #e0e0e0); color: var(--text-muted, #515c6b); white-space: nowrap;
}
.am-acc-chip.is-current { color: #16a34a; border-color: rgba(22, 163, 74, .4); }
.am-acc-meta {
  flex: 1; min-width: 0; font-size: 11px; color: var(--text-muted, #515c6b);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.am-acc-actions { display: flex; gap: 4px; flex-shrink: 0; }
.am-empty { font-size: 12px; color: var(--text-dim, #5e6673); padding: 2px 0; }

/* ===== 子面板（codebuddy API Key 表单） ===== */
.am-subpanel {
  margin-top: 8px; padding: 10px 12px; display: grid; gap: 6px;
  background: var(--bg-subtle, rgba(0, 0, 0, .03));
  border: 1px solid var(--border, #e0e0e0); border-radius: 8px;
}

/* ===== URL / TUI 状态行 ===== */
.am-url-line { margin-top: 6px; display: flex; gap: 6px; align-items: center; }
.am-url { font-size: 12px; word-break: break-all; color: var(--accent, #245bce); }
.am-tui-line { margin-top: 6px; font-size: 12px; color: var(--text-muted, #515c6b); }
.am-tui-line a { color: var(--accent, #245bce); margin-left: 6px; }

/* ===== 页脚说明 ===== */
.am-foot {
  margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border, #e0e0e0);
  font-size: 11px; line-height: 16px; color: var(--text-dim, #5e6673);
}
/* ===== 命名弹窗（保存账号档） ===== */
.am-modal-mask {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0, 0, 0, .35);
  display: flex; align-items: center; justify-content: center;
}
.am-modal {
  width: 360px; max-width: 92vw; display: grid; gap: 8px;
  padding: 14px; border-radius: 10px;
  background: var(--bg, #fff); color: var(--text, #1a1a1a);
  border: 1px solid var(--border, #e0e0e0);
  box-shadow: 0 16px 44px rgba(0, 0, 0, .32);
  font-size: 13px;
}
`;

/** 幂等注入样式（<style id> 防重复；多次 register / 多副本加载安全）。 */
export function ensureStyles() {
  if (typeof document === "undefined") return;
  const ID = "aiti-agent-manager-styles";
  if (document.getElementById(ID)) return;
  const el = document.createElement("style");
  el.id = ID;
  el.textContent = STYLES;
  document.head.appendChild(el);
}

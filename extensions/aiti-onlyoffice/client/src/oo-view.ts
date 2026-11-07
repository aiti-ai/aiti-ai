/**
 * aiti-onlyoffice · 视图（provider.render 挂载回调，纯 DOM 无 JSX）。
 *
 * 数据流（§2.4）：GET /config（JWT 签名）→ 动态加载 DS api.js → DocsAPI.DocEditor iframe。
 * 保存由 DS 内部经 callbackUrl 直写服务端（不碰 host.save / ContentProvider 管线）。
 */

const apiUrl = (p: string) => ((window as any).__aitiOnlyofficeApiUrl as (p: string) => string)?.(p) || p;

/** 加载占位 */
function loadingPane(text: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-oo-loading", "1");
  el.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text-muted,#888);font-size:13px;background:var(--bg,#fff);z-index:5;";
  const spinner = document.createElement("div");
  spinner.style.cssText = "width:22px;height:22px;border-radius:50%;border:2.5px solid var(--border,#e0e0e0);border-top-color:var(--primary,#6366f1);animation:aiti-oo-spin 0.8s linear infinite;";
  const label = document.createElement("div");
  label.textContent = text;
  el.append(spinner, label);
  if (!document.getElementById("aiti-oo-spin-style")) {
    const style = document.createElement("style");
    style.id = "aiti-oo-spin-style";
    style.textContent = "@keyframes aiti-oo-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
  }
  return el;
}

function clearLoading(container: HTMLElement): void {
  container.querySelectorAll("[data-oo-loading]").forEach((n) => n.remove());
}

/** 错误态（含「尝试其他编辑器」提示位——打开方式菜单在宿主工具条 ▦） */
function errorPane(title: string, detail: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--danger, #f87171);font-size:13px;padding:16px;text-align:center;";
  const t = document.createElement("div"); t.textContent = title;
  const d = document.createElement("div"); d.style.cssText = "color:var(--text-dim,#888);font-size:12px;word-break:break-all;max-width:80%;"; d.textContent = detail;
  const hint = document.createElement("div"); hint.style.cssText = "color:var(--text-dim,#888);font-size:12px;";
  hint.textContent = "可用工具条「▦ 打开方式」切换其他编辑器";
  el.append(t, d, hint);
  return el;
}

/**
 * DS api.js（<dsPublicUrl>/web-apps/apps/api/documents/api.js → 全局 DocsAPI）。
 * 必须走 <script src> 真实全局执行：api.js 顶层声明依赖全局作用域（loadVendorGlobal
 * 的 new Function 包装会把顶层声明困在函数作用域内，window.DocsAPI 永不挂载）。
 * api.js 非 UMD（无 define 检测），不受页面 Monaco AMD loader 影响。
 */
function loadDocsApi(dsPublicUrl: string): Promise<any> {
  const w = window as any;
  if (w.DocsAPI) return Promise.resolve(w.DocsAPI);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = dsPublicUrl.replace(/\/$/, "") + "/web-apps/apps/api/documents/api.js";
    el.async = true;
    el.onload = () => {
      if (w.DocsAPI) resolve(w.DocsAPI);
      else reject(new Error("api.js 已加载但 DocsAPI 未挂载（DS 版本异常？）"));
    };
    el.onerror = () => reject(new Error("api.js 加载失败: " + el.src));
    document.head.appendChild(el);
  });
}

/**
 * OnlyOffice DocEditor 视图。
 * 返回 { el, dispose }（provider.render 契约）。
 */
export function renderOnlyofficeView(host: any, ctx: { filePath: string; cwd?: string }): { el: HTMLElement; dispose(): void } {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg,#fff);position:relative;";
  const viewport = document.createElement("div");
  viewport.style.cssText = "flex:1;min-height:0;position:relative;overflow:hidden;";
  // DS DocEditor 需要一个占位 div（按 id 替换内容为 iframe）
  const placeholder = document.createElement("div");
  placeholder.id = "aiti-oo-editor-" + Math.random().toString(36).slice(2, 8);
  placeholder.style.cssText = "position:absolute;inset:0;";
  viewport.appendChild(placeholder);
  el.appendChild(viewport);
  viewport.appendChild(loadingPane("连接 OnlyOffice DocumentServer…"));

  let dead = false;
  let editor: any = null;

  (async () => {
    const q = new URLSearchParams({ filePath: ctx.filePath, ...(ctx.cwd ? { cwd: ctx.cwd } : {}) });
    const d = await fetch(apiUrl("/api/extensions/aiti-onlyoffice/config?" + q.toString()), { cache: "no-store" }).then((r) => r.json());
    if (dead) return;
    if (!d?.ok) throw new Error(d?.error || "config 获取失败");
    const DocsAPI = await loadDocsApi((window as any).__aitiOnlyofficeDsPublicUrl || new URL(apiUrl("/"), location.href).origin || "");
    if (dead) return;
    clearLoading(viewport);
    editor = new DocsAPI.DocEditor(placeholder.id, {
      ...d.config,
      width: "100%",
      height: "100%",
      events: {
        onDocumentReady: () => { /* DS 内部管理保存与脏态 */ },
        onError: (e: any) => console.warn("[aiti-onlyoffice] DS 事件:", e),
      },
    });
  })().catch((e) => {
    if (dead) return;
    clearLoading(viewport);
    viewport.querySelectorAll("iframe").forEach((f) => f.remove());
    viewport.appendChild(errorPane("OnlyOffice 打开失败", String((e && e.message) || e)));
  });

  return {
    el,
    dispose() {
      dead = true;
      try { editor?.destroyEditor?.(); } catch { /* 忽略 */ }
      editor = null;
    },
  };
}

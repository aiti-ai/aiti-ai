/**
 * aiti-editor · FileExplorer 右键「打开方式」（M0 §1.4 位置 C）。
 *
 * 核心 FileExplorer 零 diff：document 级 contextmenu 监听，命中
 * `[data-file-node]` 行（pi-web 侧边栏文件树自带该属性）且该文件命中
 * 多编辑器队列（≥2 项或首项为第三方渲染 provider）时，弹自绘菜单：
 *   行点击 = 用该编辑器打开（仅本次）；★ = 打开并设为默认（服务端持久化）。
 * 非文件树区域 / 内建单 provider 文件（txt/md 等）不拦截（浏览器默认菜单不动，零回归）。
 */
import { extOf, hasCapability, capabilityBadge } from "./arbiter";

interface MenuHandle { el: HTMLDivElement; close: () => void }

let installed = false;

/** 装右键监听（幂等）；返回卸载函数。 */
export function initOpenWithContextMenu(): () => void {
  if (installed) return () => {};
  installed = true;
  let current: MenuHandle | null = null;

  const close = () => {
    if (current) {
      current.close();
      current = null;
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    try {
      const target = e.target as Element | null;
      const row = target?.closest?.("[data-file-node]") as HTMLElement | null;
      if (!row) return;
      const we = (window as any).__aitiEditor;
      if (!we?.resolveProviders) return;
      const fp = row.getAttribute("data-file-node") || "";
      if (!fp) return;
      const chain = we.resolveProviders(fp) as any[];
      // 单内建 provider（txt/md/图片等）不拦截：保留浏览器默认菜单，零回归
      const interesting = chain.length > 1 || (chain[0] && typeof chain[0].render === "function");
      if (!interesting) return;
      e.preventDefault();
      close();
      current = buildMenu(e.clientX, e.clientY, fp, chain, we);
    } catch { /* 右键菜单失败不影响默认行为 */ }
  };

  // 滚动/resize/Escape/点击他处 → 收起
  const onScrollOrResize = () => close();
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const onMouseDown = (e: MouseEvent) => {
    if (current && !(e.target as Element)?.closest?.("[data-aiti-openwith-menu]")) close();
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);
  document.addEventListener("keydown", onKeyDown);

  return () => {
    installed = false;
    close();
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    document.removeEventListener("keydown", onKeyDown);
  };
}

function buildMenu(x: number, y: number, fp: string, chain: any[], we: any): MenuHandle {
  const ext = extOf(fp);
  const prefs: Record<string, string> = we.getEditorPrefs?.() || {};
  const activeId = we.getActiveProvider?.(fp)?.id;
  const name = fp.split("/").pop() || fp;

  const el = document.createElement("div");
  el.setAttribute("data-aiti-openwith-menu", "1");
  el.style.cssText = [
    "position:fixed", "z-index:9999", "min-width:240px", "max-width:340px",
    "padding:6px", "font-size:12px", "font-family:inherit",
    "background:var(--bg,#fff)", "border:1px solid var(--border,#d0d0d0)", "border-radius:10px",
    "box-shadow:0 4px 12px rgba(0,0,0,0.18)", "display:flex", "flex-direction:column", "gap:1px",
  ].join(";");
  // 视口边缘防溢出
  const mw = 260, mh = 44 + chain.length * 30;
  el.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  el.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";

  const header = document.createElement("div");
  header.textContent = "打开方式";
  header.style.cssText = "padding:3px 8px 5px;font-weight:600;font-size:11px;color:var(--text-dim,#888);";
  el.appendChild(header);

  const closeMenu = () => { try { el.remove(); } catch { /* noop */ } };

  for (const p of chain) {
    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;"
      + (p.id === activeId ? "background:var(--bg-selected,#eef2ff);" : "");
    item.addEventListener("mouseenter", () => { if (p.id !== activeId) item.style.background = "var(--bg-hover,#f3f4f6)"; });
    item.addEventListener("mouseleave", () => { if (p.id !== activeId) item.style.background = "transparent"; });

    const label = document.createElement("span");
    label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
      + (p.id === activeId ? "font-weight:600;color:var(--accent,#4f8ef7);" : "");
    label.textContent = (p.displayName || p.id) + ((p as any).sourceExt ? " · " + (p as any).sourceExt : "");
    item.appendChild(label);

    const badge = document.createElement("span");
    badge.style.cssText = "flex-shrink:0;font-size:11px;";
    badge.textContent = capabilityBadge(p);
    badge.title = hasCapability(p, "edit") ? (hasCapability(p, "preview") ? "预览 + 编辑" : "编辑") : "预览";
    item.appendChild(badge);

    if (p.id === activeId) {
      const check = document.createElement("span");
      check.style.cssText = "flex-shrink:0;color:var(--accent,#4f8ef7);font-size:11px;";
      check.textContent = "✓";
      item.appendChild(check);
    }

    const star = document.createElement("button");
    star.type = "button";
    const isDefault = prefs[ext] === p.id;
    star.textContent = isDefault ? "★" : "☆";
    star.title = isDefault ? "当前默认（点击无变化）" : "设为 " + (p.displayName || p.id) + " 为默认（持久化）";
    star.style.cssText = "flex-shrink:0;border:none;background:transparent;cursor:pointer;font-size:13px;padding:0 2px;line-height:1;"
      + (isDefault ? "color:#f59e0b;" : "color:var(--text-muted,#aaa);");
    star.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!isDefault) {
        we.setActiveProvider(fp, p.id, { makeDefault: true });
        try { we.openFile(fp); } catch { /* 打开失败静默 */ }
      }
      closeMenu();
    });
    item.appendChild(star);

    item.addEventListener("click", () => {
      if (p.id !== activeId) we.setActiveProvider(fp, p.id); // 仅本次
      try { we.openFile(fp); } catch { /* 打开失败静默 */ }
      closeMenu();
    });
    el.appendChild(item);
  }

  document.body.appendChild(el);
  return { el, close: closeMenu };
}

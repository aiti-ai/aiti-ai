/**
 * file-tags —— M6-B 编辑器联动：aiti-editor ⋯ 菜单「🏷 标签」入口（__aitiEditor.registerAction 开放点，
 * git-review 同款注册方式）。查看/增删任意文件（含非 md）的 tag；数据走本扩展 /file-tags API（同源 fetch）。
 *
 * 面板 = 零依赖 DOM 浮层（挂 body，data-ext-float 契约：拖拽/缩放/持久化由 aiti-float 接管；
 * 未装时回退普通居中浮层）。样式走内联 + CSS vars，与扩展体系同视觉语言。
 */
import { apiUrl } from "./host-shim";

const EV_OPEN = "aiti-doc-center:file-tags";
const PANEL_ID = "aiti-doc-center-file-tags-panel";
let unreg: (() => void) | null = null;

function api(p: string, init?: RequestInit): Promise<any> {
  return fetch(apiUrl("/api/extensions/aiti-doc-center" + p), init).then((r) => r.json());
}

function el(tag: string, style: Partial<CSSStyleDeclaration> & Record<string, any>, text?: string): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(style)) (n.style as any)[k] = v;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderTags(host: HTMLElement, path: string, tags: Array<{ key: string; display: string; source: string }>): void {
  host.textContent = "";
  if (!tags.length) {
    host.appendChild(el("div", { fontSize: "11px", color: "var(--text-dim,#999)", padding: "4px 0" }, "（无标签）"));
  }
  for (const t of tags) {
    const chip = el("span", {
      display: "inline-flex", alignItems: "center", gap: "4px",
      padding: "1px 8px", borderRadius: "9px", fontSize: "10.5px", margin: "2px 4px 2px 0",
      background: "color-mix(in srgb, var(--accent,#6366f1) 12%, transparent)",
      color: "var(--accent,#6366f1)", border: "1px solid color-mix(in srgb, var(--accent,#6366f1) 40%, transparent)",
    }, t.display || t.key);
    if (t.source === "db") chip.title = "手工 tag（仅存文档中心）";
    else chip.title = "文件来源：" + t.source;
    const x = el("span", { cursor: "pointer", fontWeight: "700" }, "✕");
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api("/file-tags", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, tags: [t.key] }) });
      refresh(host, path);
    });
    chip.appendChild(x);
    host.appendChild(chip);
  }
}

async function refresh(host: HTMLElement, path: string): Promise<void> {
  try {
    const d = await api("/file-tags?path=" + encodeURIComponent(path));
    renderTags(host, path, Array.isArray(d?.tags) ? d.tags : []);
  } catch {
    host.textContent = "";
    host.appendChild(el("div", { fontSize: "11px", color: "#dc2626", padding: "4px 0" }, "加载失败（文档中心未就绪？）"));
  }
}

function openPanel(path: string): void {
  let panel = document.getElementById(PANEL_ID) as HTMLElement | null;
  if (!panel) {
    panel = el("div", {
      position: "fixed", top: "52px", right: "14px", zIndex: "2147483000",
      width: "300px", maxWidth: "calc(100vw - 28px)", padding: "12px",
      background: "var(--bg,#fff)", color: "var(--text,#222)", border: "1px solid var(--border,#ddd)",
      borderRadius: "10px", boxShadow: "0 8px 24px rgba(0,0,0,.18)", fontSize: "12px",
    });
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }
  panel.textContent = "";
  panel.style.display = "block";
  panel.setAttribute("data-ext-float", "1");
  panel.setAttribute("data-ext-float-key", "aiti-doc-center:file-tags");
  panel.setAttribute("data-ext-float-w", "300");

  const head = el("div", { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", fontWeight: "700", fontSize: "12.5px" });
  head.appendChild(el("span", { flex: "1" }, "标签"));
  const close = el("span", { cursor: "pointer", padding: "0 4px", color: "var(--text-dim,#999)" }, "✕");
  close.addEventListener("click", () => { panel!.style.display = "none"; });
  head.appendChild(close);
  panel.appendChild(head);

  const pathRow = el("div", { fontSize: "10.5px", color: "var(--text-dim,#999)", marginBottom: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, path);
  panel.appendChild(pathRow);

  const tagsHost = el("div", { marginBottom: "6px" });
  panel.appendChild(tagsHost);
  void refresh(tagsHost, path);

  const row = el("div", { display: "flex", gap: "6px" });
  const input = el("input", {
    flex: "1", minWidth: "0", padding: "4px 8px", borderRadius: "6px", fontSize: "11.5px",
    border: "1px solid var(--border,#ddd)", background: "var(--bg,#fff)", color: "var(--text,#222)",
  }) as HTMLInputElement;
  input.placeholder = "新增标签（回车确认；/ 分层级）";
  const add = el("button", {
    flexShrink: "0", padding: "4px 10px", borderRadius: "6px", fontSize: "11.5px", cursor: "pointer",
    border: "1px solid var(--accent,#6366f1)", background: "var(--accent,#6366f1)", color: "#fff",
  }, "添加");
  const submit = async () => {
    const v = input.value.trim();
    if (!v) return;
    await api("/file-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, tags: [v] }) }).catch(() => null);
    input.value = "";
    void refresh(tagsHost, path);
  };
  add.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
  row.appendChild(input);
  row.appendChild(add);
  panel.appendChild(row);

  panel.appendChild(el("div", { fontSize: "10px", color: "var(--text-dim,#999)", marginTop: "6px" }, "tag 只存文档中心数据库，不改文件；非 md 文件打 tag 后进入文档中心索引。"));
}

/** 编辑器 ⋯ 菜单注册（aiti-git-review 同款开放点）；返回反注册函数或 null。 */
export function registerEditorFileTags(): (() => void) | null {
  try {
    const onOpen = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (typeof path === "string" && path) openPanel(path);
    };
    window.addEventListener(EV_OPEN, onOpen);
    if (!(window as any).__aitiEditor || typeof (window as any).__aitiEditor.registerAction !== "function") {
      return () => window.removeEventListener(EV_OPEN, onOpen);
    }
    unreg = (window as any).__aitiEditor.registerAction({
      id: "aiti-doc-center-file-tags",
      label: "🏷",
      title: "标签（文档中心：查看/增删，非 md 文件打 tag 后进索引）",
      match: (fp: string) => !!fp,
      onClick: (fp: string) => openPanel(fp),
    });
    return () => {
      try { unreg && unreg(); } catch { /* noop */ }
      window.removeEventListener(EV_OPEN, onOpen);
    };
  } catch {
    return null;
  }
}

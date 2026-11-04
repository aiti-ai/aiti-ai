/**
 * aiti-editor · 内置 mermaid 围栏渲染器（md-plugins M0）。
 *
 * mermaid 从「markdown.ts 里的内置硬编码」降级为**第一个经 `registerMdRenderer` 注册的消费者**
 * ——扩展点吃自己的狗粮：壳（边框/lang 标签/源码·预览切换/加载·错误态）归内置，本模块只管出图。
 *
 * 运行位置（方案 §4.1）：`render` 跑在**父页**，DOM 直写 srcdoc 预览 iframe（同源，函数不可序列化）。
 * mermaid.min.js 由本模块自己注进 iframe 的 head（自托管资产，一个 iframe 文档一次；文档随 srcdoc
 * 重建整体作废，旧引用自然清零）。参照 pi-web v0.9 合并版 MermaidBlock：默认出图 + 源码/预览切换
 * + SVG 下载 + 查看器缩放（0.5–3）+ 亮暗主题跟随，渲染参数一致（strict / suppressErrorRendering）。
 */
import { getBase } from "./env.ts";
import type { MdRenderCtx, MdRendererRegistration } from "./markdown.ts";

const VENDOR_PATH = "/assets/vendor/mermaid.min.js";
/** 出图失败与 vendor 载失败共用文案（同上游 i18n.invalidMermaid；壳把 message 写进错误态） */
const INVALID = "无效的 Mermaid 图表";
const VIEW_SELECTOR = '.md-fence-view[data-md-fence="mermaid"]';

/**
 * mermaid 自己的预览样式（壳样式在 markdown.ts `fenceShellCss`）。
 * 选择器带 `data-md-fence`：同文档里别的渲染器不被 mermaid 的「可缩放」观感串味。
 */
export function mermaidFenceCss(dark: boolean): string {
  const bg = dark ? "#0d1117" : "#fff";
  const fg = dark ? "#c9d1d9" : "#24292f";
  return `  /* ── Mermaid 图表块（渲染器自带；视觉对齐 pi-web MermaidBlock）── */
  .md-fence-view[data-md-fence="mermaid"]{cursor:zoom-in}
  .md-fence-view[data-md-fence="mermaid"]:hover{opacity:.85}
  .md-fence-view[data-md-fence="mermaid"] svg{display:block;max-width:none;margin:0 auto}
  /* mermaid 查看器（缩放对话框，对齐 pi-web MermaidZoomDialog） */
  .md-zoom{width:100vw;max-width:none;height:100vh;max-height:none;margin:0;padding:0;border:0;background:${bg};color:${fg}}
  .md-zoom::backdrop{background:rgba(0,0,0,.35)}
  .md-zoom-layout{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%}
  .md-zoom-toolbar{display:flex;align-items:center;gap:10px;min-height:40px;padding:7px 10px;background:${dark ? "#161b22" : "#f6f8fa"};border-bottom:1px solid ${dark ? "#30363d" : "#d0d7de"}}
  .md-zoom-title{overflow:hidden;color:${dark ? "#8b949e" : "#57606a"};font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
  .md-zoom-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
  .md-zoom-stepper{display:flex;align-items:center;height:24px;overflow:hidden;border:1px solid ${dark ? "#30363d" : "#d0d7de"};border-radius:5px;background:${bg}}
  .md-zoom-stepper button,.md-zoom-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;background:transparent;color:${dark ? "#8b949e" : "#57606a"};cursor:pointer}
  .md-zoom-icon{border:1px solid ${dark ? "#30363d" : "#d0d7de"};border-radius:5px}
  .md-zoom-stepper button:hover:not(:disabled),.md-zoom-icon:hover{background:${dark ? "#21262d" : "#eaeef2"};color:${dark ? "#c9d1d9" : "#24292f"}}
  .md-zoom-stepper button:disabled{opacity:.35;cursor:default}
  .md-zoom-value{min-width:48px;height:22px;color:${dark ? "#8b949e" : "#57606a"};font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:22px;text-align:center;user-select:none}
  .md-zoom-viewport{min-width:0;min-height:0;overflow:auto;padding:24px;background:${bg}}
  .md-zoom-canvas{padding:12px;border:1px solid ${dark ? "#30363d" : "#d0d7de"};border-radius:7px;background:${dark ? "#161b22" : "#f6f8fa"};margin:0 auto;transition:width .15s ease}
  .md-zoom-canvas svg{display:block;width:100%!important;height:auto;max-width:none!important}
`;
}

// 一个 iframe 文档 = 一次 vendor 加载（键为 iframe window：srcdoc 重建即换键，不会拿旧引用）
const _loading = new WeakMap<any, Promise<any>>();

function loadMermaid(w: any): Promise<any> {
  if (w.mermaid) return Promise.resolve(w.mermaid);
  let p = _loading.get(w);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const s = w.document.createElement("script");
      s.src = getBase() + VENDOR_PATH;
      s.onload = () => (w.mermaid ? resolve(w.mermaid) : reject(new Error(INVALID)));
      s.onerror = () => reject(new Error(INVALID));
      w.document.head.appendChild(s);
    });
    _loading.set(w, p);
  }
  return p;
}

/** SVG 下载（XMLSerializer，同 pi-web downloadMermaidSvg）：blob 与 <a> 都建在 iframe 文档里 */
function downloadSvg(doc: Document, view: Element): void {
  const w: any = doc.defaultView;
  const svg = view && view.querySelector("svg");
  if (!w || !svg) return;
  const xml = new w.XMLSerializer().serializeToString(svg);
  const url = w.URL.createObjectURL(new w.Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = "mermaid-diagram.svg";
  a.click();
  w.setTimeout(() => { try { w.URL.revokeObjectURL(url); } catch { /* 忽略 */ } }, 0);
}

/** 查看器（缩放对话框，对齐 pi-web MermaidZoomDialog：0.5–3 步进 0.25 + 适应宽度 + 边界禁用） */
function openZoom(doc: Document, view: Element): void {
  const w: any = doc.defaultView;
  const svg = view && view.querySelector("svg");
  if (!w || !svg) return;
  const xml = new w.XMLSerializer().serializeToString(svg);
  const dlg: any = doc.createElement("dialog");
  dlg.className = "md-zoom";
  dlg.innerHTML = '<div class="md-zoom-layout">'
    + '<div class="md-zoom-toolbar"><span class="md-zoom-title">mermaid</span>'
    + '<div class="md-zoom-actions">'
    + '<div class="md-zoom-stepper">'
    + '<button type="button" data-z="out" title="缩小" aria-label="缩小"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>'
    + '<span class="md-zoom-value">100%</span>'
    + '<button type="button" data-z="in" title="放大" aria-label="放大"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>'
    + '</div>'
    + '<button type="button" class="md-zoom-icon" data-z="fit" title="适应宽度" aria-label="适应宽度"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button>'
    + '<button type="button" class="md-zoom-icon" data-z="close" title="关闭" aria-label="关闭"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>'
    + '</div></div>'
    + '<div class="md-zoom-viewport"><div class="md-zoom-canvas">' + xml + '</div></div>'
    + '</div>';
  doc.body.appendChild(dlg);
  const prevOverflow = (doc.body as HTMLElement).style.overflow;
  (doc.body as HTMLElement).style.overflow = "hidden";
  let zoom = 1;
  const ZMIN = 0.5, ZMAX = 3, ZSTEP = 0.25;
  const value = dlg.querySelector(".md-zoom-value") as HTMLElement;
  const canvas = dlg.querySelector(".md-zoom-canvas") as HTMLElement;
  const outB = dlg.querySelector('[data-z="out"]') as HTMLButtonElement;
  const inB = dlg.querySelector('[data-z="in"]') as HTMLButtonElement;
  function applyZoom() {
    canvas.style.width = (zoom * 100) + "%";
    value.textContent = Math.round(zoom * 100) + "%";
    outB.disabled = zoom <= ZMIN;  // 到边界禁用（同上游 stepper）
    inB.disabled = zoom >= ZMAX;
  }
  dlg.addEventListener("click", (ev: any) => {
    const b = ev.target && ev.target.closest ? ev.target.closest("[data-z]") : null;
    if (!b) { if (ev.target.classList && ev.target.classList.contains("md-zoom-viewport")) dlg.close(); return; }
    const z = b.getAttribute("data-z");
    if (z === "out") zoom = Math.max(ZMIN, zoom - ZSTEP);
    else if (z === "in") zoom = Math.min(ZMAX, zoom + ZSTEP);
    else if (z === "fit") zoom = 1;
    else { dlg.close(); return; }
    applyZoom();
  });
  dlg.addEventListener("close", () => {
    (doc.body as HTMLElement).style.overflow = prevOverflow;
    dlg.remove();
  });
  dlg.showModal();
  applyZoom();
}

const _wired = new WeakSet<Document>();

/** 出图后的两个交互（一个文档一次委托监听）：SVG 下载按钮 / 点图开查看器 */
function wireClicks(doc: Document): void {
  if (_wired.has(doc)) return;
  _wired.add(doc);
  doc.addEventListener("click", (e: Event) => {
    const t: any = (e as any).target;
    if (!t || !t.closest) return;
    const fence = t.closest(".md-fence");
    if (!fence) return;
    const view: any = fence.querySelector(VIEW_SELECTOR);
    if (!view) return;
    if (t.closest(".md-mermaid-svg")) { downloadSvg(doc, view); return; }
    if (t.closest(".md-fence-view")) openZoom(doc, view);
  });
}

async function render(view: HTMLElement, code: string, ctx: MdRenderCtx): Promise<void> {
  const doc: Document = view.ownerDocument as Document;
  const w: any = doc && doc.defaultView;
  // 「SVG」下载按钮先藏（出图才露，同原版 hidden + 渲染成功后 unhide）；插在「源码」切换左侧保持原序
  const slot = ctx.actions;
  const svgBtn = doc.createElement("button");
  svgBtn.type = "button";
  svgBtn.className = "md-fbtn md-mermaid-svg";
  svgBtn.title = "下载文件 (SVG)";
  svgBtn.setAttribute("aria-label", "下载文件 (SVG)");
  svgBtn.textContent = "SVG";
  (svgBtn as HTMLButtonElement).hidden = true;
  if (slot) slot.insertBefore(svgBtn, slot.querySelector(".md-fence-toggle"));
  view.title = "打开 Mermaid 查看器";
  view.setAttribute("aria-label", "正在渲染 Mermaid 图表");
  if (!w) throw new Error(INVALID);
  const mermaid = await loadMermaid(w);
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: ctx.dark ? "dark" : "default" });
  } catch (e) { throw new Error(INVALID); }
  const ok = await mermaid.parse(code, { suppressErrors: true });
  if (!ok) throw new Error(INVALID);
  const r = await mermaid.render("md-mermaid-" + Date.now() + "-" + Math.random().toString(36).slice(2), code);
  view.innerHTML = r.svg;
  view.setAttribute("aria-label", "打开 Mermaid 查看器");
  (svgBtn as HTMLButtonElement).hidden = false;
  wireClicks(doc);
}

export const mermaidRenderer: MdRendererRegistration = {
  id: "aiti-editor.mermaid",
  lang: "mermaid",
  displayName: "Mermaid 图表",
  sourceExt: "aiti-editor",
  css: mermaidFenceCss,
  base: getBase(),
  render,
};

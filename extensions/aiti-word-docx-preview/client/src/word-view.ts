/**
 * aiti-word-docx-preview · .docx 高保真预览视图（provider.render 挂载回调，纯 DOM 无 JSX）。
 *
 * 数据流（方案 §2.2）：host.readFile（票据流式字节）→ docx-preview renderAsync → HTML 渲染。
 * 纯预览：不注册 ContentProvider.write，编辑诉求由能力联动路由到 aiti-word-superdoc / aiti-onlyoffice。
 */
import { loadDocxPreview } from "./word-vendor";

/** 加载占位（vendor 首拉期间给反馈，不白屏） */
function loadingPane(text: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-word-loading", "1");
  el.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text-muted,#888);font-size:13px;background:var(--bg,#fff);z-index:5;";
  const spinner = document.createElement("div");
  spinner.style.cssText = "width:22px;height:22px;border-radius:50%;border:2.5px solid var(--border,#e0e0e0);border-top-color:var(--primary,#6366f1);animation:aiti-word-spin 0.8s linear infinite;";
  const label = document.createElement("div");
  label.textContent = text;
  el.append(spinner, label);
  if (!document.getElementById("aiti-word-spin-style")) {
    const style = document.createElement("style");
    style.id = "aiti-word-spin-style";
    style.textContent = "@keyframes aiti-word-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
  }
  return el;
}

function clearLoading(container: HTMLElement): void {
  container.querySelectorAll("[data-word-loading]").forEach((n) => n.remove());
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

/** docx-preview 样式作用域隔离：渲染产物自带 <style>，包一层类名防宿主样式互串 */
const VIEW_CLASS = "aiti-docx-preview-body";

/**
 * .docx 预览视图（docx-preview 高保真渲染，分页容器）。
 * 返回 { el, dispose }（provider.render 契约）。
 */
export function renderDocxPreviewView(host: any, ctx: { filePath: string }): { el: HTMLElement; dispose(): void } {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg,#fff);position:relative;";
  // 顶条：来源说明
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;color:var(--text-dim,#888);border-bottom:1px solid var(--border,#e0e0e0);flex-shrink:0;";
  bar.textContent = "Word 文档（docx-preview 高保真预览 · 只读）";
  const viewport = document.createElement("div");
  viewport.style.cssText = "flex:1;min-height:0;overflow:auto;position:relative;";
  el.append(bar, viewport);
  viewport.appendChild(loadingPane("加载文档渲染引擎…"));

  let dead = false;
  let blobUrls: string[] = [];

  (async () => {
    const read = await host.readFile();
    if (dead) return;
    const docx = await loadDocxPreview();
    if (dead) return;
    clearLoading(viewport);
    // 渲染容器：docx-preview 自带分页 wrapper（.docx-wrapper），样式注入 styleContainer
    const body = document.createElement("div");
    body.className = VIEW_CLASS;
    const styleHost = document.createElement("div");
    viewport.append(styleHost, body);
    await docx.renderAsync(read.data, body, styleHost, {
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      ignoreFonts: false,
      useBase64URL: false,
      experimental: true,
    });
    if (dead) return;
    // 收集渲染产物的 blob: URL（图片等），dispose 时统一回收
    body.querySelectorAll("img").forEach((img) => {
      const src = (img as HTMLImageElement).src || "";
      if (src.startsWith("blob:")) blobUrls.push(src);
    });
  })().catch((e) => {
    if (dead) return;
    clearLoading(viewport);
    viewport.innerHTML = "";
    viewport.appendChild(errorPane("Word 文档解析失败", String((e && e.message) || e)));
  });

  return {
    el,
    dispose() {
      dead = true;
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* 忽略 */ } }
      blobUrls = [];
    },
  };
}

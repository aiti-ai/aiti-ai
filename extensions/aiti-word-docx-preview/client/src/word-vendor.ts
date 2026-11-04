/**
 * aiti-word-docx-preview · vendor 加载器。
 *
 * docx-preview（UMD，依赖 JSZip 全局）+ jszip（UMD，挂 JSZip）——均走受控执行
 * （loadVendorGlobal，防 Monaco AMD 劫持）；docx-preview 挂载全局 `docx`。
 */
import { loadVendorGlobal } from "./vendor-loader";

const base = () => {
  // 优先：register(ctx) 注入的 basePath 感知 apiUrl（多实例 /dev 前缀安全）
  const api = (window as any).__aitiWordDocxPreviewApiUrl;
  if (typeof api === "function") {
    try { return api("/api/extensions/aiti-word-docx-preview/assets/"); } catch { /* 兜底 */ }
  }
  // 兜底：bundle 自身 URL（含 basePath 与 /assets/ 前缀）
  const m = import.meta.url.match(/^(.*\/assets\/)client\//);
  if (m) return m[1];
  return "/api/extensions/aiti-word-docx-preview/assets/";
};

const v = (f: string) => base() + "vendor/" + f;

/** jszip（docx-preview 前置依赖：UMD 工厂吃 JSZip 全局） */
export function loadJSZip(): Promise<any> {
  return loadVendorGlobal(v("jszip.min.js"), "JSZip");
}

/** docx-preview（挂全局 docx；renderAsync(data, body, styleHost, opts)） */
export async function loadDocxPreview(): Promise<any> {
  await loadJSZip();
  return loadVendorGlobal(v("docx-preview.min.js"), "docx");
}

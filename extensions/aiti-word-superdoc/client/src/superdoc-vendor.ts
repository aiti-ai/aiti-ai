/**
 * aiti-word-superdoc · SuperDoc 引擎加载器（vite ESM 单 vendor chunk，Univer 同款路线）。
 *
 * SuperDoc 2.x dist 把 vue/yjs external（裸说明符），浏览器直连 import 无法解析——
 * 与 aiti-sheet-univer 同解：vite 构建期把 superdoc + node_modules 全家收进单一 chunk
 * （DI/上下文单实例天然一致）。**本模块只被 word-view 的动态 import 引用**（入口保持
 * 零白拉）；样式注入由 word-view 的 loadSuperdocVendor() 在 import 前完成（并行下载）。
 * AGPL-3.0：SuperDoc 经 npm 依赖进本扩展 chunk，不装本扩展即零 AGPL（方案 §2.3）。
 */
import { SuperDoc } from "superdoc";
import "superdoc/style.css";

export { SuperDoc };

export interface SuperdocInstance {
  sd: any;                    // SuperDoc 实例（export/setDocumentMode/destroy…）
  ready: Promise<void>;       // ready 事件 resolve；异常 reject
}

/**
 * 创建 SuperDoc 实例。
 * @param mountEl 挂载容器（编辑器页面）
 * @param toolbarEl 工具栏容器（内建 toolbar；editable=false 传 null 用 viewing 模式）
 * @param bytes .docx 字节
 * @param opts.editable 编辑态（editing + toolbar）/ 预览态（viewing + 无工具栏）
 */
export async function createSuperdoc(
  mountEl: HTMLElement,
  toolbarEl: HTMLElement | null,
  bytes: ArrayBuffer,
  opts: { editable: boolean; onUpdate?: () => void },
): Promise<SuperdocInstance> {
  const sd: any = new SuperDoc({
    selector: mountEl,
    document: bytes,
    documentMode: opts.editable ? "editing" : "viewing",
    role: opts.editable ? "editor" : "viewer",
    user: { name: "本地用户" },
    ...(toolbarEl && opts.editable
      ? { ui: { toolbar: { container: toolbarEl }, comments: false, search: true, ruler: false } }
      : { ui: { comments: false, contextMenu: false, search: false, ruler: false } }),
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    sd.on("ready", () => { if (!settled) { settled = true; resolve(); } });
    sd.on("content-error", (p: any) => { if (!settled) { settled = true; reject(new Error(String(p?.message || p || "文档内容错误"))); } });
    sd.on("exception", (p: any) => { if (!settled) { settled = true; reject(new Error(String(p?.message || p?.error || "SuperDoc 异常"))); } });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error("SuperDoc 加载超时（30s）")); } }, 30000);
  });
  if (opts.onUpdate) {
    try { sd.on("editor-update", () => opts.onUpdate?.()); } catch { /* 事件缺席无碍 */ }
  }
  return { sd, ready };
}

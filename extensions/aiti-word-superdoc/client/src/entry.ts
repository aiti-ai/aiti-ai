/**
 * aiti-word-superdoc · client 入口（M1b，docs/aiti-editor-office-plan.md §2.3）。
 *
 * 注册（经共享注入缓冲，aiti-editor 加载时序无关）：
 *   - aiti-word-superdoc.docx  .docx  预览+编辑（SuperDoc 自身渲染保真足够，预览态=只读编辑器）
 *   - ContentProvider "aiti-word-superdoc" → save-blob（共享 blob-save-route 工厂）
 * word.edit feature 门控（默认开；关 → 仅预览）。
 * AGPL-3.0：SuperDoc 隔离在本扩展 vendor/，不装即无（方案 §2.3 策略红利）。
 * 重复注册幂等：先 dispose 上一轮（disposables 挂 window 单例，跨 bundle 重载存活）。
 */
import { whenAitiEditorReady } from "../../../_shared/aiti-editor-inject.mjs";
import { renderSuperdocView, persistBytes } from "./word-view";

function register(ctx: Record<string, any>): void {
  // apiUrl（多实例 /dev 前缀安全）→ word-view 的 save-blob fetch / vendor 路径用
  (window as any).__aitiWordSuperdocApiUrl = (p: string) => (typeof ctx.apiUrl === "function" ? ctx.apiUrl(p) : p);

  whenAitiEditorReady(() => {
    const we = (window as any).__aitiEditor;

    // 幂等：清上一轮注册（扩展 client 重载 / 热更场景）
    const disposables: Array<() => void> = (window as any).__aitiWordSuperdocDisposables || [];
    for (const off of disposables) { try { off(); } catch { /* 忽略 */ } }
    disposables.length = 0;

    // feature：word.edit（默认开；关 → 仅预览，编辑诉求落空 → 能力联动提示）
    let editable = true;
    try {
      const f = ctx.getFeatures?.() || {};
      if (f["word.edit"] === false) editable = false;
    } catch { /* 缺席默认开 */ }

    const caps: Array<"preview" | "edit"> = editable ? ["preview", "edit"] : ["preview"];

    disposables.push(we.registerEditorProvider({
      id: "aiti-word-superdoc.docx",
      displayName: "Word 编辑（SuperDoc）",
      sourceExt: "aiti-word-superdoc",
      selector: { extensions: [".docx"] },
      capabilities: caps,
      defaultCapability: "preview",
      contentProvider: "aiti-word-superdoc",
      about: {
        summary: ".docx 在线编辑（ProseMirror 双向：打开即 docx 结构，导出即 docx 文件）",
        capabilities: [
          "所见即所得编辑（标题 / 粗斜体 / 列表 / 表格 / 图片 / 链接）",
          "编辑态内建工具栏（字号 / 对齐 / 颜色 / 撤销重做）",
          "Ctrl+S 保存回原文件（409 冲突确认覆盖）；另存为 .docx 副本",
          "预览态=只读编辑器（与编辑态同一渲染引擎，无二次转换）",
          "文件变化实时跟随（watch）",
        ],
        limits: [
          "复杂排版（文本框 / 艺术字 / SmartArt / 脚注尾注）导出可能近似",
          "打开时重新序列化整个文档：与原 Word 排版细节可能有差异（保真档请用 OnlyOffice）",
          "首次加载需拉取 ~2.5MB（gzip）引擎",
        ],
        vendor: "SuperDoc 2.12 (AGPL-3.0，隔离于本扩展) + ProseMirror (MIT)",
        license: "AGPL-3.0",
      },
      render: (host: any, c: any) => renderSuperdocView(host, c),
    }));

    disposables.push(we.registerContentProvider({
      id: "aiti-word-superdoc",
      async write(filePath: string, data: ArrayBuffer, baseMtimeMs: number) {
        return await persistBytes(filePath, data, baseMtimeMs);
      },
    }));

    (window as any).__aitiWordSuperdocDisposables = disposables;
  });
}

export default register;

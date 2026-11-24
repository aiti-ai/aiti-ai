/**
 * aiti-word-superdoc · 服务端（薄壳）。
 *
 * 职责（方案 §2.3）：仅一个 save-blob route（SuperDoc exportDocx 字节写盘，共享
 * blob-save-route 工厂）。SuperDoc / ProseMirror 全部是 client vendor 依赖——服务端零数据面依赖。
 * 读文件复用核心 /api/files（经 aiti-editor 票据端点）。
 */
import { createBlobSaveRoute } from "./blob-save-route";

const saveBlobRoute = createBlobSaveRoute({
  extId: "aiti-word-superdoc",
  allowedExts: [".docx"],
  maxBytes: 30 * 1024 * 1024,
});

export default {
  id: "aiti-word-superdoc",
  name: "aiti-word-superdoc",
  description: "Word 文档编辑器（SuperDoc：ProseMirror docx 双向）：.docx 预览+编辑。AGPL 隔离于本扩展，不装即无",
  client: "dist/aiti-word-superdoc-client.mjs",
  icon: "icon.svg",
  features: [
    { id: "word.edit", label: "Word 编辑保存", description: "开启后 .docx 提供 edit 能力（保存走 save-blob）；关闭仅预览", default: true },
  ],

  ui: {
    // [first-load chunk governance] Lazy + idle materialization: the provider shell (~small ESM)
    // materializes in the first idle window after boot (ExtSlots scheduleIdleMaterialize) and
    // registers into aiti-editor's provider registry via the shared inject buffer (load-order
    // independent). Vendor sub-chunks stay strictly on-demand (first file open).
    // NOTE: the previous top-level "clientImmediately: true" was dead config — the registry
    // only reads ui.clientImmediately — so these were effectively eager before this change.
    clientImmediately: false,
    prefetchOnIdle: true, // Word 编辑器（SuperDoc）在首个空闲窗口物化注册 provider；vendor 子链仍按需
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "ext.displayName": "Word 编辑",
      },
      en: {
        "feat.word.edit.desc": "When on, .docx gets edit capability (saves via save-blob); off = preview only",
        "ext.displayName": "Word Editor",
        "feat.word.edit": "Word edit & save",
      },
    },
  },

  server: {
    startup(ctx: any) {
      console.log("[aiti-word-superdoc] 就绪");
    },
    async api(req: Request, ctx: any) {
      const p = new URL(req.url).pathname.split("/").filter(Boolean);
      if (p[p.length - 1] === "save-blob" && req.method === "POST") {
        return await saveBlobRoute(req);
      }
      return new Response(JSON.stringify({ ok: false, error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
};

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
  version: "0.1.0",
  description: "Word 文档编辑器（SuperDoc：ProseMirror docx 双向）：.docx 预览+编辑。AGPL 隔离于本扩展，不装即无",
  client: "dist/aiti-word-superdoc-client.mjs",
  clientImmediately: true,
  icon: "icon.svg",
  features: [
    { id: "word.edit", label: "Word 编辑保存", description: "开启后 .docx 提供 edit 能力（保存走 save-blob）；关闭仅预览", default: true },
  ],
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

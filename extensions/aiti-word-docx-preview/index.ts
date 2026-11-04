/**
 * aiti-word-docx-preview · 服务端（薄壳，零 route）。
 *
 * 职责（方案 §2.2）：纯 client 扩展——docx-preview 渲染在浏览器端完成，
 * 无编辑（不注册 ContentProvider.write）、无 save-blob、无服务端数据面依赖。
 * 读文件复用核心 /api/files（经 aiti-editor 票据端点）。
 */
export default {
  id: "aiti-word-docx-preview",
  name: "aiti-word-docx-preview",
  version: "0.1.0",
  description: "Word 文档预览（docx-preview 高保真只读）：.docx 分页渲染，页眉页脚/表格/图片还原",
  client: "dist/aiti-word-docx-preview-client.mjs",
  clientImmediately: true,
  icon: "icon.svg",
  features: [],
  server: {
    startup(ctx: any) {
      console.log("[aiti-word-docx-preview] 就绪");
    },
  },
};

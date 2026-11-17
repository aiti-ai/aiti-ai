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
  description: "Word 文档预览（docx-preview 高保真只读）：.docx 分页渲染，页眉页脚/表格/图片还原",
  client: "dist/aiti-word-docx-preview-client.mjs",
  clientImmediately: true,
  icon: "icon.svg",
  features: [],

  ui: {
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "ext.displayName": "Word 预览",
      },
      en: {
        "ext.displayName": "Word Preview",        "ext.description": "Word document preview (docx-preview, high-fidelity read-only): .docx paginated rendering with headers/footers/tables/images restored",
      },
    },
  },

  server: {
    startup(ctx: any) {
      console.log("[aiti-word-docx-preview] 就绪");
    },
  },
};

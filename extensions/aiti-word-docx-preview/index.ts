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
  icon: "icon.svg",
  features: [],

  ui: {
    // [first-load chunk governance] Lazy + idle materialization: the provider shell (~small ESM)
    // materializes in the first idle window after boot (ExtSlots scheduleIdleMaterialize) and
    // registers into aiti-editor's provider registry via the shared inject buffer (load-order
    // independent). Vendor sub-chunks stay strictly on-demand (first file open).
    // NOTE: the previous top-level "clientImmediately: true" was dead config — the registry
    // only reads ui.clientImmediately — so these were effectively eager before this change.
    clientImmediately: false,
    prefetchOnIdle: true, // Word 预览（docx-preview）在首个空闲窗口物化注册 provider；vendor 子链仍按需
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "ext.displayName": "Word 预览",
      },
      en: {
        "ext.displayName": "Word Preview",
      },
    },
  },

  server: {
    startup(ctx: any) {
      console.log("[aiti-word-docx-preview] 就绪");
    },
  },
};

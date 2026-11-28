/**
 * aiti-word-docx-preview · client 入口（M1b，docs/aiti-editor-office-plan.md §2.2）。
 *
 * 注册（经共享注入缓冲，aiti-editor 加载时序无关）：
 *   - aiti-word-docx-preview.docx  .docx  纯预览（无 ContentProvider.write——
 *     编辑诉求由能力联动自动路由到 aiti-word-superdoc / aiti-onlyoffice）。
 * 重复注册幂等：先 dispose 上一轮（disposables 挂 window 单例，跨 bundle 重载存活）。
 */
import { whenAitiEditorReady } from "../../../_shared/aiti-editor-inject.mjs";
import { renderDocxPreviewView } from "./word-view";

function register(ctx: Record<string, any>): void {
  // apiUrl（多实例 /dev 前缀安全）→ word-vendor 的 vendor 路径用
  (window as any).__aitiWordDocxPreviewApiUrl = (p: string) => (typeof ctx.apiUrl === "function" ? ctx.apiUrl(p) : p);

  whenAitiEditorReady(() => {
    const we = (window as any).__aitiEditor;

    // 幂等：清上一轮注册（扩展 client 重载 / 热更场景）
    const disposables: Array<() => void> = (window as any).__aitiWordDocxPreviewDisposables || [];
    for (const off of disposables) { try { off(); } catch { /* 忽略 */ } }
    disposables.length = 0;

    disposables.push(we.registerEditorProvider({
      id: "aiti-word-docx-preview.docx",
      displayName: "Word 预览（docx-preview）",
      sourceExt: "aiti-word-docx-preview",
      selector: { extensions: [".docx"] },
      capabilities: ["preview"],
      defaultCapability: "preview",
      about: {
        summary: ".docx 高保真只读预览（页面级还原：分页 / 页眉页脚 / 表格 / 图片 / 列表）",
        capabilities: [
          "高保真分页渲染（比核心 mammoth 纯 HTML 转换显著还原）",
          "页眉 / 页脚 / 脚注 / 尾注渲染",
          "表格 / 图片 / 超链接 / 列表样式还原",
          "零安装解析（纯 JS，文件不落第三方服务）",
          "文件变化实时跟随（watch）",
        ],
        limits: [
          "只读：编辑诉求由「打开方式」路由到 SuperDoc / OnlyOffice 扩展",
          "复杂排版（文本框 / 艺术字 / SmartArt / 批注）还原有限",
        ],
        vendor: "docx-preview 0.4 (Apache-2.0) + JSZip 3.10 (MIT/GPLv3 双许可)",
      },
      render: (host: any, c: any) => renderDocxPreviewView(host, c),
    }));

    (window as any).__aitiWordDocxPreviewDisposables = disposables;
  });
}

export default register;

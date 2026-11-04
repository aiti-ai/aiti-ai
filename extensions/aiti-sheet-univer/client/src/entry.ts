/**
 * aiti-sheet-univer · client 入口（M1a，docs/aiti-editor-office-plan.md §2.1）。
 *
 * 注册（经共享注入缓冲，aiti-editor 加载时序无关）：
 *   - aiti-sheet-univer.sheet        .xlsx/.xlsm  预览+编辑（sheet.edit feature 关 → 仅预览）
 *   - aiti-sheet-univer.xls-readonly .xls/.ods    只读预览（@e965/xlsx）
 *   - ContentProvider "aiti-sheet-univer" → save-blob（共享 blob-save-route 工厂）
 * 重复注册幂等：先 dispose 上一轮（disposables 挂 window 单例，跨 bundle 重载存活）。
 */
import { whenAitiEditorReady } from "../../../_shared/aiti-editor-inject.mjs";
import { renderSheetView, renderLegacySheetView, persistBytes } from "./sheet-view";

function register(ctx: Record<string, any>): void {
  // apiUrl（多实例 /dev 前缀安全）→ sheet-view 的 save-blob fetch 用
  (window as any).__aitiSheetUniverApiUrl = (p: string) => (typeof ctx.apiUrl === "function" ? ctx.apiUrl(p) : p);

  whenAitiEditorReady(() => {
    const we = (window as any).__aitiEditor;

    // 幂等：清上一轮注册（扩展 client 重载 / 热更场景）
    const disposables: Array<() => void> = (window as any).__aitiSheetUniverDisposables || [];
    for (const off of disposables) { try { off(); } catch { /* 忽略 */ } }
    disposables.length = 0;

    // feature：sheet.edit（默认开；关 → 仅预览，编辑诉求落空 → 能力联动提示）
    let editable = true;
    try {
      const f = ctx.getFeatures?.() || {};
      if (f["sheet.edit"] === false) editable = false;
    } catch { /* 缺席默认开 */ }

    const caps: Array<"preview" | "edit"> = editable ? ["preview", "edit"] : ["preview"];

    disposables.push(we.registerEditorProvider({
      id: "aiti-sheet-univer.sheet",
      displayName: "Excel（Univer）",
      sourceExt: "aiti-sheet-univer",
      selector: { extensions: [".xlsx", ".xlsm"] },
      capabilities: caps,
      defaultCapability: "preview",
      contentProvider: "aiti-sheet-univer",
      about: {
        summary: "Excel 表格预览与编辑（exceljs 数据面 + Univer 视图面）",
        capabilities: [
          ".xlsx/.xlsm 打开：样式 / 公式 / 合并 / 冻结 / 行高列宽 / 多 sheet / 隐藏 sheet / tab 色",
          "单元格编辑与保存（Ctrl+S），样式、公式、数字格式往返保持",
          "保存冲突检测（外部修改 → 409 → 确认覆盖）",
          "不支持项保存前明示（顶部警告条）",
          "「打开方式」可与其他编辑器共存；编辑能力可用 sheet.edit 功能开关整体关闭",
        ],
        limits: [
          "图表、透视表、条件格式、数据验证：不支持，保存时剥离（打开时警告条提示）",
          "富文本单元格并为纯文本；超链接仅保留显示文本",
          "保存经 exceljs 重写整个工作簿：.xlsm 宏/VBA 保留不保证，未识别的扩展属性可能丢失",
          "超过 5 万行 / 2000 列截断（只渲染前段）",
          "数字格式含 ODF 条件 token（value()>0 等）会被净化，显示可能略有差异",
        ],
        vendor: "exceljs 4.4 (MIT) + Univer 0.25 (Apache-2.0)",
      },
      render: (host: any, c: any) => renderSheetView(host, c),
    }));

    disposables.push(we.registerEditorProvider({
      id: "aiti-sheet-univer.xls-readonly",
      displayName: "旧格式表格（只读）",
      sourceExt: "aiti-sheet-univer",
      selector: { extensions: [".xls", ".ods"] },
      capabilities: ["preview"],
      defaultCapability: "preview",
      about: {
        summary: "旧格式表格（.xls / .ods）只读预览",
        capabilities: ["内容表格化展示（多 sheet 分节）", "零安装解析（纯 JS）", "文件变化实时跟随（watch）", "一键「转为 .xlsx 并打开」：派生 -fromxls.xlsx 副本（不覆盖原文件；重名自动 (1)/(2) 递增）"],
        limits: ["仅数据还原，不含样式", "只读：编辑走转换出的 .xlsx 副本（原文件不动）"],
        vendor: "@e965/xlsx 0.20 (Apache-2.0) + soffice（转换）",
      },
      render: (host: any, c: any) => renderLegacySheetView(host, c),
    }));

    disposables.push(we.registerContentProvider({
      id: "aiti-sheet-univer",
      async write(filePath: string, data: ArrayBuffer, baseMtimeMs: number) {
        return await persistBytes(filePath, data, baseMtimeMs);
      },
    }));

    (window as any).__aitiSheetUniverDisposables = disposables;
  });
}

export default register;

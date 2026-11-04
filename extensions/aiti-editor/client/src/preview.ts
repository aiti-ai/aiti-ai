/**
 * aiti-editor · 「这个文件有没有预览面」的唯一判据（纯函数，零 window/ctx 依赖）。
 *
 * 方案：docs/aiti-editor-html-preview-plan.md §3.1
 * 为什么单独一个模块：预览门禁原先硬编码 `isMarkdown`（语言 === markdown），HTML 想接预览就得
 *   在 editor-app 里到处 `||` 一次——能力（capability）判定收在这里，editor-app 只问「有没有/是哪类」。
 *
 * 判据用**扩展名**而非 `detectLanguage`：LANG_EXT 把 .vue 也映射成 html language，
 *   但 .vue 不是独立可渲染文档，给它「预览」按钮只会渲染出一坨模板垃圾。
 */

export type PreviewKind = "markdown" | "html";

/**
 * 扩展名判据。**与 `LANG_EXT` 的 markdown 条目保持一致**（多一个就会渲染出空白预览面：
 * 类型说有、`isMarkdown` 说没有）；`.mkd` 之类靠 provider 声明 languageId 走下面的参数。
 */
const KIND_BY_EXT: Record<string, PreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
};

/**
 * 预览类型（无预览面 → null）。
 * @param language 已解析的 Monaco 语言（provider 可给非常规扩展名声明 markdown）；html **不看语言**
 *                 ——LANG_EXT 把 .vue 映射成 html，但它不是独立可渲染文档。
 */
export function previewKindOf(filePath: string, language = ""): PreviewKind | null {
  if (language === "markdown") return "markdown";
  const base = String(filePath || "").split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  if (i <= 0) return null;
  return KIND_BY_EXT[base.slice(i + 1).toLowerCase()] || null;
}

/** 打开文件时的默认视图：有预览面的两类都「预览优先」（对齐宿主旧行为）。 */
export function defaultViewModeOf(filePath: string, language = ""): "preview" | "edit" {
  return previewKindOf(filePath, language) ? "preview" : "edit";
}

export interface ModeItem { label: string; value: string; title: string }

/** 三模式条目（edit/split/preview）：两类共用同一套，差异在预览面内部而非切换器。 */
export function previewModeItems(kind: PreviewKind | null): ModeItem[] {
  if (!kind) return [];
  const renderLabel = kind === "html" ? "渲染页面预览" : "渲染预览";
  return [
    { label: "编辑", value: "edit", title: "编辑源码" },
    { label: "分栏", value: "split", title: "左侧编辑·右侧预览" },
    { label: "预览", value: "preview", title: renderLabel },
  ];
}

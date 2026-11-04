/**
 * aiti-editor · HTML 预览的纯函数层（快速态 srcdoc / 真预览态 URL / 视口预设）。
 *
 * 方案：docs/aiti-editor-html-preview-plan.md §3.3
 * 零 window/ctx 依赖 → `node --test` 直测（UI 在 html-preview.tsx）。
 *
 * 两态分工：
 *   快速态 = 编辑器**缓冲**（未保存所见即所得）+ `<base>` 指向票据目录拿兄弟资源 + 正则剥脚本；
 *   真预览态 = 服务端**磁盘**文档（原生相对解析与站内导航），origin 隔离靠响应头 `CSP: sandbox`。
 * 安全定位（诚实版）：真正的边界是 **opaque origin**（srcdoc 的 sandbox 不给 allow-same-origin；
 *   服务态靠 CSP 头）。剥脚本只是「默认不执行」的便利层——正则漏网也拿不到 pi-web 的任何东西。
 */

/** 剥脚本实现收在 `../../preview/strip-scripts.ts`：服务态（真预览）与快速态必须同一判据。 */
import { stripUserScripts } from "../../preview/strip-scripts.ts";
export { stripUserScripts };

/** 在 `<head>` 后插标记（没有 head 就补一个 head；连 html 都没有就前置——浏览器会自动补齐）。 */
function injectIntoHead(html: string, tag: string): string {
  const src = String(html == null ? "" : html);
  const head = /<head\b[^>]*>/i.exec(src);
  if (head) return src.slice(0, head.index + head[0].length) + tag + src.slice(head.index + head[0].length);
  const htmlTag = /<html\b[^>]*>/i.exec(src);
  if (htmlTag) return src.slice(0, htmlTag.index + htmlTag[0].length) + "<head>" + tag + "</head>" + src.slice(htmlTag.index + htmlTag[0].length);
  return "<head>" + tag + "</head>" + src;
}

export interface HtmlSrcdocOpts {
  /** 编辑器缓冲全文 */
  content: string;
  /** preview 路由基址（**必须带 origin**：srcdoc 文档自身 URL 是 about:srcdoc，相对 base 无处解析）；"" = 无兄弟资源 */
  base: string;
  /** 脚本开关（false = 剥脚本，同时 CSP 无从叠加——边界靠 sandbox） */
  scripts: boolean;
  dark: boolean;
  /** 上报 shim 源码（与注入版同源，见 ../../preview/preview-shim.ts）；"" = 不注入 */
  shim: string;
}

/** 快速态 srcdoc。返回 `stripped` = 剥掉的脚本/属性处数（供 UI 说明）。 */
export function buildHtmlPreviewSrcdoc(opts: HtmlSrcdocOpts): { doc: string; stripped: number } {
  let body = String(opts.content == null ? "" : opts.content);
  let stripped = 0;
  if (!opts.scripts) {
    const cut = stripUserScripts(body);
    body = cut.html;
    stripped = cut.removed;
  }
  if (opts.base && !/<base\b/i.test(body)) body = injectIntoHead(body, '<base href="' + String(opts.base).replace(/"/g, "%22") + '">');
  // 只声明配色倾向：页面自带样式优先（不替作者重画背景，避免「预览一片黑」）
  body = injectIntoHead(body, "<style>:root{color-scheme:" + (opts.dark ? "dark" : "light") + "}</style>");
  if (opts.shim) body += "<script>" + opts.shim + "<\/script>";
  return { doc: body, stripped };
}

/**
 * 预览基址补成绝对形态。**快速态必须**：srcdoc 文档自身 URL 是 `about:srcdoc`，
 * 根相对 `<base href="/dev/api/…">` 无处解析（相对资源全断）；服务态靠 shim 运行时归一。
 * @param from 解析基准（父页 location.href）
 */
export function absBase(base: string, from: string): string {
  const src = String(base || "");
  if (!src) return "";
  try { return new URL(src).href; } catch { /* 相对形态，需要基准 */ }
  try { return new URL(src, from).href; } catch { return ""; }
}

/**
 * 真预览态 iframe src。`rel` = 票据目录内相对路径（"" = 入口文档）；
 * `scripts=false` → `?noscript=1`（服务端剥作者脚本，见 preview/preview-serve.ts 的 servePreviewDoc）；
 * `v` = 刷新破缓存计数。
 */
export function previewUrl(base: string, rel: string, opts: { scripts: boolean; v?: number }): string {
  const root = String(base || "");
  const path = root + String(rel || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const qs: string[] = [];
  if (!opts.scripts) qs.push("noscript=1");
  if (typeof opts.v === "number" && opts.v >= 0) qs.push("v=" + opts.v);
  return path + (qs.length ? (path.indexOf("?") >= 0 ? "&" : "?") + qs.join("&") : "");
}

/**
 * shim 上报的相对路径 → dock 可打开的绝对路径（预览命名空间内）。
 * 越出入口目录、带盘符/协议、绝对路径 → ""（调用方据此忽略；服务端路由本就会 403，这里不重复越权）。
 * 分隔符随 filePath（Windows 用 \），不做大小写/存在性判定（交给 openFile）。
 */
export function resolvePreviewRel(filePath: string, rel: string): string {
  const fp = String(filePath || "");
  const i = fp.lastIndexOf("/");
  const j = fp.lastIndexOf("\\");
  const cut = Math.max(i, j);
  if (cut <= 0) return "";
  const dir = fp.slice(0, cut);
  const sep = fp[cut] === "\\" ? "\\" : "/";
  const raw = String(rel || "").replace(/[?#].*$/, "");
  if (!raw || raw.indexOf("\0") >= 0) return "";
  if (/^[a-zA-Z]:/.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.charAt(0) === "/" || raw.charAt(0) === "\\") return "";
  const out: string[] = [];
  for (const seg of raw.split(/[/\\]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (out.pop() === undefined) return ""; continue; }
    out.push(seg);
  }
  return out.length ? dir + sep + out.join(sep) : "";
}

export interface ViewportPreset { id: string; label: string; width: number | null; title: string }

/** 视口预设（宽度 = CSS px，非设备像素倍率——只解决「窄栏里看不到宽版式」）。 */
export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: "auto", label: "自适应", width: null, title: "跟随预览区宽度" },
  { id: "1280", label: "桌面 1280", width: 1280, title: "按 1280px 宽度排版（横向可滚）" },
  { id: "768", label: "平板 768", width: 768, title: "按 768px 宽度排版" },
  { id: "390", label: "手机 390", width: 390, title: "按 390px 宽度排版" },
];

export function viewportWidthOf(id: string): number | null {
  const p = VIEWPORT_PRESETS.find((x) => x.id === id);
  return p ? p.width : null;
}

/** 视口 → 外层滚动容器 + iframe 尺寸（固定宽度时 iframe 定宽居中，外框可横滚）。 */
export function viewportStyle(width: number | null, dark: boolean): { wrap: Record<string, string>; frame: Record<string, string> } {
  const wrap: Record<string, string> = { position: "absolute", inset: "0", overflow: "auto" };
  const frame: Record<string, string> = { border: "none", display: "block" };
  if (!width) {
    frame.width = "100%";
    frame.height = "100%";
    return { wrap, frame };
  }
  wrap.padding = "12px";
  wrap.boxSizing = "border-box";
  wrap.background = dark ? "#0d1117" : "#eef0f3";
  frame.width = width + "px";
  frame.height = "100%";
  frame.margin = "0 auto";
  frame.background = "#fff"; // 定宽画布：与周围留白区分开，才看得出「这是 768 的版式」
  frame.boxShadow = "0 1px 8px rgba(0,0,0,.28)";
  return { wrap, frame };
}

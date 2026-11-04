/**
 * aiti-editor · markdown 预览 → aiti-msg-smart 弹层适配（纯逻辑，可单测）。
 *
 * 预览是同源 srcdoc iframe（`markdown.ts` 生成的文档），iframe 内点击语义块/代码行会
 * postMessage `aiti-editor-preview-click`（只带语义：文本 + 源码行区间 + 行号/字符偏移），
 * 本模块把它合成 msg-smart 弹层引擎需要的 `info`（`aiti-msg-smart.popover` 服务）：
 *   - doc/win 指向 iframe 文档 → 弹层渲染进 iframe（坐标/滚动/层叠自洽，见方案 D1）；
 *   - float:true → 块级元素也走 fixed 浮层（iframe 里 setInline 是 body 追加层，in-flow 会掉底）；
 *   - decorateQuote → 引用带 `@<file>#Lx[-Ly]` 源码定位；
 *   - caps → 预览语境关掉 question/providers/跨仓分辨。
 * 服务缺席（aiti-msg-smart 未装/禁用）→ 全程静默降级：预览照常，只是没有弹层。
 */
import { extSvc } from "./host-shim.ts";
import { getCtx } from "./env.ts";

export const POPOVER_SVC = "aiti-msg-smart.popover";

/** iframe → 父窗的点击消息（由 markdown.ts 生成的脚本发出）。 */
export interface PreviewClickMsg {
  type: "aiti-editor-preview-click";
  /** data-aiti-blk 锚点值（父窗据此回查 iframe 内元素） */
  blk: string;
  kind: "block" | "code-line";
  text: string;
  row: number | null;
  charOffset: number | null;
  srcStart: number;
  srcEnd: number;
}

export interface PopoverApi {
  open(info: Record<string, unknown>): void;
  close(): void;
  toDom(node: unknown): Node | null;
}

/** 取弹层服务（懒加载/缺席 → undefined；调用方必须判空）。 */
export function getPopover(): PopoverApi | undefined {
  const s = extSvc<any>(POPOVER_SVC);
  return s && typeof s.open === "function" ? (s as PopoverApi) : undefined;
}

// 服务不做缓存：每次点击/渲染现场取（msg-smart 懒加载、热重载重挂都能即时生效，无需订阅）

/** 目录部分（相对路径解析基准 = 文件所在目录，而非会话 cwd——文档里的 ./x.md 指同目录）。 */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** 源码行区间 → @ 定位串（无有效行号时退化为纯文件引用）。 */
export function srcRef(filePath: string, start?: number, end?: number): string {
  const s = Number(start);
  if (!Number.isFinite(s) || s < 1) return "@" + filePath;
  const e = Number(end);
  return "@" + filePath + "#L" + s + (Number.isFinite(e) && e > s ? "-L" + e : "");
}

export interface ClickInfoOpts {
  /** iframe 文档（msg-smart 由此决定 DOM 宿主） */
  doc: any;
  /** iframe window（滚动/resize 跟随） */
  win: any;
  /** 当前编辑文件的绝对路径（引用前缀 + 相对路径基准） */
  filePath: string;
  /** 元素回查（默认 doc.querySelector('[data-aiti-blk="…"]')；测试可注入） */
  findElement?: (blk: string) => any;
}

/**
 * 点击消息 → msg-smart 的 info。找不到锚点元素（标注失配/文档已重建）→ null，调用方忽略。
 */
export function previewClickInfo(msg: PreviewClickMsg, opts: ClickInfoOpts): Record<string, any> | null {
  const { doc, win, filePath } = opts;
  if (!doc || !win || !msg) return null;
  const find = opts.findElement
    || (typeof doc.querySelector === "function"
      ? (blk: string) => doc.querySelector('[data-aiti-blk="' + String(blk).replace(/["\\]/g, "") + '"]')
      : null);
  const el = find ? find(String(msg.blk)) : null;
  if (!el) return null;
  const isLine = msg.kind === "code-line";
  // 代码行：anchorRect 按字符偏移取该逻辑行的真实视觉矩形（msg-smart 既有约定）
  if (isLine && typeof msg.charOffset === "number" && msg.charOffset >= 0) {
    try { el.__aitiClickedOffset = msg.charOffset; } catch { /* 只读元素忽略 */ }
  }
  const ref = srcRef(filePath, msg.srcStart, msg.srcEnd);
  let layer: any = null;
  return {
    text: msg.text || "",
    cwd: dirOf(filePath),
    element: el,
    doc,
    win,
    rowIndex: isLine ? msg.row : null,
    float: true, // 块级也 fixed（iframe 内 setInline 是 body 追加层）
    paragraphId: "mdprev:" + filePath + ":" + msg.blk + ":" + (isLine ? String(msg.row) : "-"),
    decorateQuote: (q: string) => ref + "\n" + q,
    caps: { question: false, providers: false, fileExternalRoots: false },
    setInline: (node: unknown) => {
      try {
        if (!layer) { layer = doc.createElement("div"); doc.body.appendChild(layer); }
        layer.innerHTML = "";
        const api = getPopover();
        const dom = api && typeof api.toDom === "function" ? api.toDom(node) : null;
        if (dom) layer.appendChild(dom);
      } catch { /* 渲染失败不影响预览 */ }
    },
    close: () => {
      try { if (layer) { layer.remove(); layer = null; } } catch { /* ignore */ }
    },
  };
}

/** 关闭当前弹层（srcdoc 重建 / 切视图模式 / 卸载前调用）。 */
export function closePreviewPopover(): void {
  try { getPopover()?.close(); } catch { /* ignore */ }
}

/** feature editor.mdPreviewSmart（默认开；关掉时 iframe 不发点击消息）。 */
export function mdSmartEnabled(): boolean {
  try {
    const c = getCtx() as any;
    const f = c && typeof c.getFeatures === "function" ? (c.getFeatures() || {}) : {};
    return f["editor.mdPreviewSmart"] !== false;
  } catch { return true; }
}

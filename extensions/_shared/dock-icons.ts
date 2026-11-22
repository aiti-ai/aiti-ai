/**
 * _shared/dock-icons.ts — single source of truth for dock system icons:
 * operational icons (position / move / navigate) + block semantic icons
 * (collapsed-header title icon, consumed by the DockBody icon prop and
 * manifest static-entry meta.icon).
 *
 * Usage (plan docs/pi-web-dock-icon-row-plan.md):
 *   · position menu icon rows (float / left / right / reserved bottom) — D1 React / D2·D3 DOM consistent;
 *   · DockBody ⋮ "move up / down" icons;
 *   · navigation character buttons as icons (chevron-left/right, arrow-up);
 *   · block semantic icons (folder/clock/bot/…): sidebar block-header icon + lazy-extension
 *     static shell (manifest entry icon field, name string → rendered by DockBody dockIconEl).
 *
 * 设计约定：
 *   · 不依赖 react、不读部署资产——区别于 `_shared/icons/*.svg`（扩展条目图标契约，需宿主
 *     loader/copyIcons 部署）；本文件是纯节点数据 + 双端渲染 helper，构建时按现有机制内联进
 *     各消费 bundle，零部署资产、零运行时请求。
 *   · 图形规范（与现有头行内联 SVG 一致）：viewBox 0 0 24 24、stroke=2、round 线稿（lucide 同款）。
 *   · 节点用数据描述（tag + attrs）而非字符串，React 端 `h(tag, attrs)` 与 DOM 端
 *     `createElementNS` 各自组装，无 innerHTML / dangerouslySetInnerHTML。
 */

export type DockIconName =
  | "float" | "new-window" | "panel-left" | "panel-right" | "panel-bottom"
  | "chevron-up" | "chevron-down" | "chevron-left" | "chevron-right" | "arrow-up"
  | "pin" | "pin-off" | "x" | "trash" | "move-diagonal-2"
  | "folder" | "clock" | "bot" | "library" | "shield-check"
  | "git-branch" | "history" | "file" | "plug" | "mic" | "box"
  | "aiti-ai-logo";

/** Single SVG child node. attrs use native SVG kebab-case names (verbatim for DOM
 *  setAttribute; for React JSX spread them through dockIconReactAttrs — React rejects
 *  kebab-case SVG props with an "Invalid DOM property" warning). */
export interface DockIconNode {
  tag: "path" | "rect" | "circle" | "line" | "polyline";
  attrs: Record<string, string | number>;
}

const P = (d: string): DockIconNode => ({ tag: "path", attrs: { d } });
const R = (x: number, y: number, width: number, height: number, rx = 2): DockIconNode =>
  ({ tag: "rect", attrs: { x, y, width, height, rx } });
/** 节点级细线覆盖：stroke-width 1.5（24 viewBox）→ 13px 渲染 ≈0.81px，与 Catppuccin
 *  文件夹图标（16 viewBox / stroke 1）同线宽。子节点显式属性优先于根继承，三端
 *  （dockIconEl / createDockIconSvg / dockIconDecl 序列化）attrs 全透传，零特判。 */
const thin = (n: DockIconNode): DockIconNode => ({ ...n, attrs: { ...n.attrs, "stroke-width": 1.5 } });

/** 图标节点表（lucide 图形；「方框+粗边」= panel-* 家族，与截图同款语言）。 */
export const DOCK_ICON_NODES: Record<DockIconName, DockIconNode[]> = {
  /** 浮窗：圆角框 + 标题栏 + 圆点（app-window；用户 2026-09-15 定稿 C）。 */
  float: [
    R(2, 4, 20, 16, 2),
    P("M10 4v4"),
    P("M2 8h20"),
    P("M6 4v4"),
  ],
  /** 新窗口打开：方框 + 右上外斜箭头（square-arrow-out-up-right；
   *  用户 2026-09-15 拍板：B 图形用作「新窗口打开」，且仅支持的面板（文件/文件夹）显示）。 */
  "new-window": [
    P("M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"),
    P("m21 3-9 9"),
    P("M15 3h6v6"),
  ],
  /** 左栏：方框 + 左缘粗边。 */
  "panel-left": [R(3, 3, 18, 18), P("M9 3v18")],
  /** 右栏：方框 + 右缘粗边。 */
  "panel-right": [R(3, 3, 18, 18), P("M15 3v18")],
  /** 底部（预留位）：方框 + 下缘粗边。 */
  "panel-bottom": [R(3, 3, 18, 18), P("M3 15h18")],
  "chevron-up": [P("m18 15-6-6-6 6")],
  "chevron-down": [P("m6 9 6 6 6-6")],
  "chevron-left": [P("m15 18-6-6 6-6")],
  "chevron-right": [P("m9 18 6-6-6-6")],
  "arrow-up": [P("m5 12 7-7 7 7"), P("M12 19V5")],
  /** 钉住：图钉（lucide pin；⋮ 区块操作「钉住」，与 aiti-folder MiPin 同形）。 */
  pin: [
    { tag: "line", attrs: { x1: 12, y1: 17, x2: 12, y2: 22 } },
    P("M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"),
  ],
  /** 关闭：×（lucide x；⋮ 区块操作「关闭」）。 */
  x: [P("M18 6 6 18"), P("m6 6 12 12")],
  /** 取消钉住态：图钉 + 斜删除线（lucide pin-off；移动行钉住钮已钉态，与 MiPin 同语义族）。 */
  "pin-off": [
    { tag: "line", attrs: { x1: 12, y1: 17, x2: 12, y2: 22 } },
    P("M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"),
    { tag: "line", attrs: { x1: 2, y1: 2, x2: 22, y2: 22 } },
  ],
  /** 移除本实例：垃圾桶（lucide trash；多实例区块 ⋮「移除本实例」，与 aiti-folder MiTrash 同形）。 */
  trash: [
    { tag: "polyline", attrs: { points: "3 6 5 6 21 6" } },
    P("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"),
    { tag: "line", attrs: { x1: 10, y1: 11, x2: 10, y2: 17 } },
    { tag: "line", attrs: { x1: 14, y1: 11, x2: 14, y2: 17 } },
  ],
  /** 移动：对角双箭头（lucide move-diagonal-2；⋮「移动」行首图标——左上 + 右下，用户 2026-09-15 指定）。 */
  "move-diagonal-2": [
    P("M5 11V5h6"),
    P("M19 13v6h-6"),
    P("M5 5l14 14"),
  ],

  /* ── Block semantic icons (collapsed-header icons; lucide line style) ── */
  /** Projects block (session-manager projects): the aiti-ai logo as line art (chosen by
   *  the user 2026-11-26 from the icon candidates preview; prototype = aiti-docs
   *  docs/.vuepress/public/logo.svg). Three brand elements: large-rounded square (the
   *  gradient tile) + geometric letter a (circle + stem) + top-right spark (from the
   *  logo's yellow dot). Visual weight kept on par with the folder/file glyph family:
   *  the spark dot is stroked, not filled (a filled node reads much heavier at 13px),
   *  and the letter circle stays small so line density matches single-outline glyphs. */
  "aiti-ai-logo": [
    thin(R(3, 3, 18, 18, 4)),
    thin({ tag: "circle", attrs: { cx: 10, cy: 14, r: 2.8 } }),
    thin(P("M12.8 11.2v5.6")),
    thin({ tag: "circle", attrs: { cx: 16.8, cy: 7.2, r: 1.2 } }),
    thin(P("m18.8 5.3 1.5-1.6")),
    thin(P("m19.2 8.2 2.1-.4")),
  ],
  /** Folder block (aiti-folder faces): single folder (lucide folder). */
  folder: [
    P("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"),
  ],
  /** Scheduled tasks block (aiti-ai-schedule tasks): clock (lucide clock). */
  clock: [
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: "polyline", attrs: { points: "12 6 12 12 16 14" } },
  ],
  /** Subagent fleet block (aiti-subagents fleet): robot (lucide bot). */
  bot: [
    P("M12 8V4H8"),
    R(4, 8, 16, 12),
    P("M2 14h2"),
    P("M20 14h2"),
    P("M15 13v2"),
    P("M9 13v2"),
  ],
  /** Prompt library block (aiti-prompts panel): bookshelf lines (lucide library). */
  library: [
    P("m16 6 4 14"),
    P("M12 6v14"),
    P("M8 8v12"),
    P("M4 4v16"),
  ],
  /** Model availability block (aiti-model-check panel): shield + check (lucide shield-check). */
  "shield-check": [
    P("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"),
    P("m9 12 2 2 4-4"),
  ],
  /** Watch paths block (aiti-git-trace watch): branch (lucide git-branch). */
  "git-branch": [
    { tag: "line", attrs: { x1: 6, y1: 3, x2: 6, y2: 15 } },
    { tag: "circle", attrs: { cx: 18, cy: 6, r: 3 } },
    { tag: "circle", attrs: { cx: 6, cy: 18, r: 3 } },
    P("M18 9a9 9 0 0 1-9 9"),
  ],
  /** Timeline block (aiti-git-trace timeline): clock + counterclockwise arrow (lucide history). */
  history: [
    P("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"),
    P("M3 3v5h5"),
    P("M12 7v5l4 2"),
  ],
  /** File panel block (aiti-editor file faces): document (lucide file). */
  file: [
    P("M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"),
    P("M14 2v4a2 2 0 0 0 2 2h4"),
  ],
  /** ACP management block (aiti-acp-agent manage): plug (lucide plug). */
  plug: [
    P("M12 22v-5"),
    P("M9 8V2"),
    P("M15 8V2"),
    P("M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"),
  ],
  /** Speech recognition block (aiti-ai-input asr): microphone (lucide mic). */
  mic: [
    P("M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"),
    P("M19 10v2a7 7 0 0 1-14 0v-2"),
    { tag: "line", attrs: { x1: 12, y1: 19, x2: 12, y2: 22 } },
  ],
  /** Dock demo block (demo): 3D box (lucide box). */
  box: [
    P("M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"),
    P("m3.3 7 8.7 5 8.7-5"),
    P("M12 22V12"),
  ],
};

/* ── Host-contract form export (for registering-entry meta.icon) ── */

/* ── Host-contract form export (for registering-entry meta.icon) ── */

/** Name-table glyph → host ExtUiItemIcon contract form `{ svg: markup }` (inner markup,
 *  24×24 line style). For extensions declaring icons on registering entries
 *  (rightFileDock meta.icon → dock tab semantic icon): the host's renderExtItemIcon
 *  renders it — no dependency on the extension-side DockBody; the glyph definition
 *  still has its single source in this name table. */
export function dockIconDecl(name: DockIconName): { svg: string } {
  const markup = DOCK_ICON_NODES[name]
    .map((n) => `<${n.tag} ${Object.entries(n.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")} />`)
    .join("");
  return { svg: markup };
}

/** zone / 位置 → 方位图标名（D1/D2/D3 位置菜单数据共用）。 */
export function dockIconOfZone(zone: string): DockIconName {
  if (zone === "float" || zone === "floating") return "float";
  if (zone === "sidebar-explorer" || zone.startsWith("sidebar:")) return "panel-left";
  if (zone === "bottom-panel" || zone.startsWith("bottom:")) return "panel-bottom";
  return "panel-right";
}

/* ── DOM 端（D2 aiti-float / D3 降级菜单；core 亦可 re-export）── */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 构造一个完整 svg 元素（currentColor / stroke=2 / round；aria-hidden）。 */
export function createDockIconSvg(name: DockIconName, size = 16): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const node of DOCK_ICON_NODES[name] ?? []) {
    const el = document.createElementNS(SVG_NS, node.tag);
    for (const [k, v] of Object.entries(node.attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/* ── React side (D1 ext-float-dock.ts + extensions): consumers assemble via ctx.h / JSX ──
 * Usage (h flavor):
 *   h("svg", { width: 16, height: 16, ...DOCK_ICON_SVG_ROOT_PROPS, "aria-hidden": "true" },
 *     ...DOCK_ICON_NODES[name].map((n, i) => h(n.tag, { key: i, ...dockIconReactAttrs(n.attrs) })))
 * Root props constant lives here so both render flavors never drift. */
export const DOCK_ICON_SVG_ROOT_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** React-side attr-name adaptation: native kebab-case SVG names ("stroke-width",
 *  "stroke-linecap", ...) → JSX camelCase, so node data can stay DOM-native while
 *  React consumers stay warning-free. aria-/data- prefixed keys pass through unchanged. */
export function dockIconReactAttrs(attrs: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[!k.includes("-") || k.startsWith("aria-") || k.startsWith("data-")
      ? k
      : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

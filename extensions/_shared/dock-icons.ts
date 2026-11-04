/**
 * _shared/dock-icons.ts — dock 体系操作图标（方位 / 移动 / 导航）的**单一数据源**。
 *
 * 用途（方案 docs/pi-web-dock-icon-row-plan.md）：
 *   · 位置菜单「方位图标排」（浮窗 / 左栏 / 右栏 / 预留底部）——D1 React / D2·D3 DOM 多端一致；
 *   · DockBody ⋮「上移 / 下移」移动图标；
 *   · 导航类字符按钮图标化（chevron-left/right、arrow-up）。
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
  | "pin" | "x" | "trash" | "move-diagonal-2";

/** 单个 SVG 子节点（attrs 用 SVG 原生名；全部小写、React/DOM 双兼容）。 */
export interface DockIconNode {
  tag: "path" | "rect" | "circle" | "line" | "polyline";
  attrs: Record<string, string | number>;
}

const P = (d: string): DockIconNode => ({ tag: "path", attrs: { d } });
const R = (x: number, y: number, width: number, height: number, rx = 2): DockIconNode =>
  ({ tag: "rect", attrs: { x, y, width, height, rx } });

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
};

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

/* ── React 端（D1 ext-float-dock.ts 与各扩展）：消费方以 ctx.h / JSX 组装 ──
 * 用法（h 版）：
 *   h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
 *              strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
 *     ...DOCK_ICON_NODES[name].map((n, i) => h(n.tag, { key: i, ...n.attrs })))
 * 此处提供 SVG 根属性常量，避免两端漂移。 */
export const DOCK_ICON_SVG_ROOT_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

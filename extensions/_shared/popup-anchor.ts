/**
 * _shared/popup-anchor.ts — 弹层固定定位公共小工具（零 react，构建期内联进各扩展 bundle）。
 *
 * 背景：左栏 sidebar-container（桌面端宽度动画 overflow:hidden）→ StackCell → DockBody
 * 全链 overflow:hidden，absolute 锚定的弹层（下拉/菜单）在矮格/折叠格/栈底格一律被
 * 祖先裁剪（弹层自身 getBoundingClientRect 仍在视口内 → 视口钳位兜底探测不到）。
 * 出路 = 弹层一律 position:fixed 锚定触发器矩形——fixed 逃逸 overflow 裁剪；唯
 * transform/filter 等祖先会成为 fixed 的 containing block，此时坐标须按其原点校正
 * （fixedOrigin）。
 */

/** 祖先是否构成 fixed containing block（CSS 常用子集：transform/perspective/filter、
 *  will-change 声明同类属性、contain 布局系取值）。 */
function isFixedContainingBlock(cs: CSSStyleDeclaration): boolean {
  if (cs.transform !== "none" || cs.perspective !== "none" || cs.filter !== "none") return true;
  if (/transform|perspective|filter/.test(cs.willChange || "")) return true;
  const c = cs.contain;
  return c === "strict" || c === "content" || c === "layout" || c === "paint";
}

/** el 最近 fixed-containing-block 祖先的原点（视口坐标；无 = {x:0,y:0}）。
 *  fixed 弹层坐标 = 期望视口坐标 − 本值（无 transformed 祖先时即视口坐标）。 */
export function fixedOrigin(el: Element): { x: number; y: number } {
  let n = el.parentElement;
  while (n && n !== document.documentElement) {
    try {
      if (isFixedContainingBlock(getComputedStyle(n))) {
        const r = n.getBoundingClientRect();
        return { x: r.left, y: r.top };
      }
    } catch { /* ignore */ }
    n = n.parentElement;
  }
  return { x: 0, y: 0 };
}

/** 视口内钳制（pad 内边距；宽/高超视口时贴 pad 对齐）。入参/返回均为视口坐标。 */
export function clampToViewport(left: number, top: number, width: number, height: number, pad = 8): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.max(pad, Math.min(left, vw - pad - width)),
    top: Math.max(pad, Math.min(top, Math.max(pad, vh - pad - height))),
  };
}

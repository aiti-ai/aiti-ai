/**
 * aiti-float · 层叠上下文判定（置前用，纯函数零 DOM）。
 *
 * 背景：置前要把「困住面板 z-index 的祖先」（遮罩层惯例）一起抬，否则面板提不到别的弹窗之上。
 * 但「最近的定位祖先」≠「层叠上下文」——`position: relative` + `z-index: auto` 只是绘制层次
 * 参与者的布局容器（宿主消息区根 `.chat-content` 即此类），抬它等于把整块布局区域提到宿主
 * 堆叠阶梯（左栏 200 / 右栏 250）之上，两区内容互相穿插。抬之前先问「它真的困住后代吗」。
 *
 * 入参取 CSSStyleDeclaration 的只读子集，测试可用普通对象打桩。
 */
export interface StackingStyle {
  position: string;
  zIndex: string;
  transform: string;
  filter: string;
  backdropFilter?: string;
  opacity: string;
  willChange: string;
  isolation: string;
  mixBlendMode: string;
  contain: string;
}

export function createsStackingContext(cs: StackingStyle): boolean {
  if (cs.transform && cs.transform !== "none") return true;
  if (cs.filter && cs.filter !== "none") return true;
  if (cs.backdropFilter && cs.backdropFilter !== "none") return true;
  if (cs.isolation === "isolate") return true;
  if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return true;
  const o = parseFloat(cs.opacity);
  if (Number.isFinite(o) && o < 1) return true;
  if (/(^|[\s,])(layout|paint|content|strict)(\s|,|$)/.test(cs.contain || "")) return true;
  if (/(transform|filter|opacity|contain)/.test(cs.willChange || "")) return true;
  // fixed/sticky 在现代浏览器始终自成层叠上下文（即使 z-index: auto）
  if (cs.position === "fixed" || cs.position === "sticky") return true;
  const z = (cs.zIndex || "auto").trim();
  return cs.position !== "static" && z !== "auto";
}

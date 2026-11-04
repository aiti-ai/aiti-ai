/**
 * aiti-float · 弹窗浮动增强器主体（DOM 级，自手写 .mjs 版迁移，逻辑一比一）。
 *
 * scan() 扫 DOM → 出现未增强的 [data-ext-float] 面板（有实际尺寸）→ 接管定位
 * （left/top/width/height !important）+ 手势 + 持久化。
 * 契约（属性全表 + 给扩展作者的约定）见扩展 index.ts 头注释 / docs/aiti-web-ext-float-dialogs.md。
 */
import { attachGesture } from "./gesture";
import * as dock from "./dock";
import { createBackLayerManager, type BackLayerManager, type OverlayBackService } from "./back-layer";
import { createsStackingContext } from "./stacking";
import { FLOAT_INSTALLED_EVENT, positionMenuModel, appendDockIconRow, resolveDropZone, SIDEBAR_DROP_ZONE, type DockZone, type PresentState } from "../../../_shared/ext-float-dock-core";

const DONE_ATTR = "data-piwe-float-done";
// 遮罩自动去除标记（v0.4.5）：盖在面板祖先的半透明全屏遮罩层上 → CSS 令其透明 + 点击穿透
const BACKDROP_ATTR = "data-piwe-float-mask-off";
// 旧版标记（v0.1.x 用 data-ext-float-done）：同页还活着旧模块实例时（热重载不卸载），
// 增强后同步盖上旧标记 → 旧模块 scan 跳过，不再双增强器打架（capture 互顶 → 拖一下就停）
const LEGACY_DONE_ATTR = "data-ext-float-done";
/** 单例插槽：新实例安装前拆除旧实例（observer/window 监听/面板级手势），防热重载叠实例 */
const INSTANCE_SLOT = "__PIWE_FLOAT_INSTANCE__"; // 带前缀：防与同名机制撞（历史教训：框架层同名标记导致双增强器打架）
const LS_PREFIX = "pi-web:ext-float:v1:";
const CSS_ID = "piweb-ext-float-css";

export const VERSION = "0.5.1"; // 0.5.1：置前不再连带打标「非层叠上下文」的定位祖先（.chat-content 这类布局容器）——修复点 plan/ask 卡后整块透明消息区压过左栏 200/右栏 250、两区内容互相穿插；0.5.0：小屏系统返回关闭浮窗（+位置菜单）——消费宿主 pi-web.overlayBack 退栈服务，旧宿主/桌面自动降级；见 docs/pi-web-mobile-back-dismiss-plan.md

/** 小屏全屏断点：只看宽度（≤640px）。高度不参与判定——输入法弹起/短窗口等高度变化
 *  会造成「弹窗突然铺满视口」的翻转；矮宽窗口由 clampState 镂回视口，可用 ⛶ 手动最大化 */
const FULL_MQ = "(max-width: 640px)";

const CSS_TEXT = [
  ".piwe-float-h { position: absolute; z-index: 5; touch-action: none; user-select: none; }",
  ".piwe-float-se { right: -4px; bottom: -4px; width: 18px; height: 18px; cursor: nwse-resize; }",
  ".piwe-float-e  { right: -4px; top: 14%; bottom: 14%; width: 8px; cursor: ew-resize; }",
  ".piwe-float-s  { bottom: -4px; left: 14%; right: 14%; height: 8px; cursor: ns-resize; }",
  ".piwe-float-w  { left: -4px; top: 14%; bottom: 14%; width: 8px; cursor: ew-resize; }",
  '.piwe-float-se::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px;',
  "  border-right: 2px solid rgba(128,128,128,.55); border-bottom: 2px solid rgba(128,128,128,.55);",
  "  border-radius: 0 0 2px 0; }",
  ".piwe-float-h:hover::after, .piwe-float-se:hover::after { border-color: var(--accent, #2563eb); }",
  ".piwe-float-dragging { transition: none !important; will-change: transform; }", // 拖动走合成层 + 关过渡防跟手延迟
  ".piwe-float-dragging, .piwe-float-dragging * { user-select: none !important; }",
  // 遮罩自动去除（0.4.5）：!important 压过 React 内联样式（重渲染冲不掉）；backdrop-filter
  // 一并清掉（否则背景透明了整屏模糊还在）；直接子级恢复 auto（pointer-events 继承链会被
  // 父级 none 污染，面板 subtree 必须显式接回，否则弹窗自己也点不了）。
  `[${BACKDROP_ATTR}] { background: none !important; pointer-events: none !important; backdrop-filter: none !important; }`,
  `[${BACKDROP_ATTR}] > * { pointer-events: auto; }`,
].join("\n");

// 拖拽把手上按住这些元素不触发拖拽（不吞按钮/输入的点击）
const INTERACTIVE_SEL =
  'button, a, input, textarea, select, label, [contenteditable="true"], [contenteditable="plaintext-only"], [role="button"], [role="slider"], [role="tab"]';

const MAX_BTN_ATTR = "data-piwe-max-btn";
const DOCK_BTN_ATTR = "data-piwe-dock-btn";

// ---- 标准最大化按钮（自动注入，v0.4.0） ----
// 面板增强时自动往标题栏（拖拽把手）塞 ⛶/❐ 按钮；扩展零代码，豁免加 data-ext-float-max="0"。
// 手动最大化态按钮保持可见（❐=还原）；仅小屏全屏态隐藏（复用缩放手柄的 syncFull 显隐链路）。
function maxBtnWanted(panel: HTMLElement): boolean {
  const v = (panel.getAttribute("data-ext-float-max") ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "no" || v === "false" || v === "off");
}
function floatHandleOf(panel: HTMLElement): HTMLElement | null {
  const marked = panel.querySelector<HTMLElement>("[data-ext-float-drag]");
  if (marked) return marked;
  return panel.firstElementChild instanceof HTMLElement ? panel.firstElementChild : null;
}

/** 关闭符号（纯文本为这些之一的交互元素视为 ✕ 关闭钮） */
const CLOSE_TXTS = ["✕", "×", "✖", "⨯", "❌"];

/** 在把手内找 ✕ 关闭钮：aria-label/title 含 关闭|close，或纯关闭符号文本。取 DOM 序最后一个（最右）。 */
function closeButtonOf(handle: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  handle.querySelectorAll<HTMLElement>('button, a, [role="button"]').forEach((el) => {
    if (!handle.contains(el)) return;
    const label = ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).toLowerCase();
    const txt = (el.textContent || "").trim();
    if (/关闭|close/i.test(label) || CLOSE_TXTS.includes(txt)) best = el;
  });
  return best;
}

function ensureMaxBtn(panel: HTMLElement, fullApplied: boolean): void {
  if (!maxBtnWanted(panel)) {
    panel.querySelectorAll(`[${MAX_BTN_ATTR}]`).forEach((b) => b.remove());
    return;
  }
  const handle = floatHandleOf(panel);
  if (!handle || handle === panel) return;
  // 锚点 = ✕ 关闭钮（可深嵌套，如「刷新+✕」包一层 div）；退化找把手内最后一个直接子级交互元素
  const anchor = closeButtonOf(handle)
    ?? (() => {
      let a: Element | null = null;
      for (let i = handle.children.length - 1; i >= 0; i--) {
        const k = handle.children[i];
        if (k instanceof Element && k.matches(INTERACTIVE_SEL)) { a = k; break; }
      }
      return a;
    })();
  // 已有按钮：位置正确（紧邻锚点左）就不动；被 React 重渲染挤走则重插（自愈）
  const existing = panel.querySelector<HTMLElement>(`[${MAX_BTN_ATTR}]`);
  if (existing) {
    const inPlace = !anchor || (existing.parentElement === anchor.parentElement && existing.nextElementSibling === anchor);
    if (inPlace) {
      // 全屏显隐：手动最大化（isMax）时保持可见供还原；仅小屏全屏才藏。
      // 同值守卫：无条件写 style 会触发 attribute mutation → 观察者风暴燃料。
      const nextDisplay = fullApplied && !(maxControls.get(panel)?.isMax() ?? false) ? "none" : "";
      if (existing.style.display !== nextDisplay) existing.style.display = nextDisplay;
      return;
    }
    existing.remove();
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute(MAX_BTN_ATTR, "1");
  // 复用缩放手柄的全屏显隐链路，但 syncFull 对本按钮特殊处理：手动最大化时保持可见（❐ 还原），仅小屏全屏隐藏
  btn.setAttribute("data-piwe-float-h", "1");
  const syncIcon = () => {
    const maxed = maxControls.get(panel)?.isMax() ?? false;
    btn.textContent = maxed ? "❐" : "⛶";
    btn.title = maxed ? "还原" : "全屏";
    btn.setAttribute("aria-label", btn.title);
  };
  // 动态取 maxControls（热重载重增强后同一按钮仍指向新控制句柄）
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    try { maxControls.get(panel)?.toggle(); } catch { /* ignore */ }
    syncIcon();
  });
  btn.style.cssText = "background:none;border:none;color:var(--text-muted,#888);cursor:pointer;"
    + "font-size:13px;line-height:1;padding:2px 6px;flex-shrink:0;font-family:inherit;";
  syncIcon();
  // 插入：✕ 关闭钮紧邻左侧（同一父节点内）；无锚点则追加到把手末尾
  try {
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(btn, anchor);
    else handle.appendChild(btn);
  } catch { try { handle.appendChild(btn); } catch { /* ignore */ } }
  btn.style.display = fullApplied && !(maxControls.get(panel)?.isMax() ?? false) ? "none" : "";
}

interface FloatState { x: number; y: number; w: number; h: number }

/* ── dock 状态机接线（方案 aiti-web-ext-float-dock-plan §5.3/§6）── */

/** 位置选择器菜单（v3.1 共享构建器 + v5 图标排）：浮窗态 ⇱（panel 属性 zones）/ TabBar dock tab ⇱
 *  （dock-menu 事件，zones 解析见 resolveMenuData）/ 降级层同构菜单全走这里。
 *  项 = 浮窗 + 各声明 zone（当前态高亮锁定、声明默认位带圆点）；数据/渲染与 D1/D3
 *  共用 core 的 positionMenuModel + appendDockIconRow（图标排，方案 docs/pi-web-dock-icon-row-plan.md）。
 *  同 key 已开菜单再触发 = 关闭（toggle）；点外自关。 */
let openMenuKey: string | null = null;
let openMenuEl: HTMLElement | null = null;
/** 刚被 dismiss（点外/mousedown）关闭的菜单：同 key 350ms 内不重开——锚按钮 toggle 时
 *  mousedown 先触发 dismiss、click 再触发 open，没有这条会「关了又闪开」。 */
let lastDismiss: { key: string; at: number } | null = null;

/* ── 小屏系统返回关闭浮窗（宿主 pi-web.overlayBack 退栈服务消费方，方案 docs/pi-web-mobile-back-dismiss-plan.md）──
 * 历史退栈的唯一写入口在宿主；本扩展只 acquire/release，绝不监听 popstate（两套栈互踩）。
 * 旧宿主 / 桌面（>640px）自动降级：不注册，返回语义不变。 */
let overlayBackService: OverlayBackService | null = null;
let backLayers: BackLayerManager | null = null;
let menuBackLayers: BackLayerManager | null = null;
let backMedia: MediaQueryList | null = null;

/** 宿主退栈服务上下线（entry.ts 经 ctx.getExtService/onExtServiceChange 调用）。 */
export function setOverlayBackService(service: OverlayBackService | null): void {
  overlayBackService = service;
  backLayers?.syncAll();
  menuBackLayers?.syncAll();
}

/** 点面板自己的 ✕ 关闭（每次现查，React 重渲染换钮也不失效）。 */
function dismissPanel(panel: HTMLElement): void {
  const handle = floatHandleOf(panel);
  const button = handle ? closeButtonOf(handle) : null;
  if (button) (button as HTMLElement).click();
}

/** scan 自愈时补挂返回层：面板有 ✕ 才纳入（无 ✕ 的不可关闭，不注册避免死返回）。 */
function refreshBackLayer(panel: HTMLElement): void {
  const manager = backLayers;
  if (!manager || manager.knows(panel)) return;
  const handle = floatHandleOf(panel);
  if (handle && closeButtonOf(handle)) manager.panelReady(panel);
}

function closePositionMenu(): void {
  if (openMenuEl) menuBackLayers?.panelGone(openMenuEl);
  openMenuEl?.remove();
  openMenuEl = null;
  openMenuKey = null;
}

function openPositionMenu(key: string, anchor: { left: number; bottom: number }, zones: string[], def: string | null): void {
  if (openMenuKey === key
    || (lastDismiss && lastDismiss.key === key && Date.now() - lastDismiss.at < 350)) {
    closePositionMenu();
    return;
  } // 同 key toggle（含刚被锚按钮 mousedown dismiss 的场景）
  closePositionMenu();
  const menu = document.createElement("div");
  menu.style.cssText = "position:fixed;z-index:2147483600;background:var(--bg-panel,#1a1a1a);border:1px solid var(--border,#444);"
    + "border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:190px;";
  menu.style.left = Math.max(8, anchor.left - 60) + "px";
  menu.style.top = anchor.bottom + 4 + "px";
  const cur = dock.presented(key);
  // v5 图标排（方案 §3.4）：统一模型（浮窗 → 各停靠位）+ 共享 DOM 行构造（当前态锁定/
  // 默认位圆点/hover tooltip 均在 appendDockIconRow 内）；点可点项先关菜单再执行。
  const items = positionMenuModel(key, zones as DockZone[], (def ?? undefined) as DockZone | undefined, cur as PresentState, { onNewWindow: dock.windowOpenerOf(key) });
  appendDockIconRow(menu, items, { label: "停靠方位", onPick: () => closePositionMenu() });
  document.body.appendChild(menu);
  openMenuKey = key;
  openMenuEl = menu;
  menuBackLayers?.panelReady(menu); // 小屏返回优先关位置菜单（toggle 时先 closePositionMenu 已 release）
  const dismiss = (ev: MouseEvent) => {
    if (menu.contains(ev.target as Node)) return;
    lastDismiss = { key, at: Date.now() };
    closePositionMenu();
    document.removeEventListener("mousedown", dismiss, true);
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

/** TabBar ⇱ 事件的菜单数据解析：zones 注册表（declareDockZones/浮窗增强时注册）→
 *  停靠 face / 浮窗面板 DOM 属性兜底 → 当前 docked 区。default 同序。 */
function resolveMenuData(key: string): { zones: string[]; def: string | null } {
  let zones = dock.zonesOf(key);
  let def = dock.defaultZoneOf(key);
  if (!zones.length) {
    const dockBody = document.querySelector<HTMLElement>(`[data-ext-float-dock-body="${key}"]`);
    const floatPanel = document.querySelector<HTMLElement>(`[data-ext-float-key="${key}"]`);
    const raw = (dockBody?.getAttribute("data-ext-float-dock") ?? floatPanel?.getAttribute("data-ext-float-dock") ?? "").trim();
    zones = raw ? raw.split(/\s+/).filter(Boolean) : [];
    def = def ?? dockBody?.getAttribute("data-ext-float-dock-default") ?? floatPanel?.getAttribute("data-ext-float-dock-default") ?? null;
  }
  if (!zones.length) {
    const cur = dock.presented(key);
    if (cur.startsWith("docked:")) zones = [cur.slice(7)];
  }
  return { zones, def };
}

/** 浮窗态 ⇱（ensureDockBtn 用）：zones 来自面板属性（v3 行为不变，菜单走共享构建器）。 */
function openDockMenu(panel: HTMLElement, key: string, zones: string[], btn: HTMLElement): void {
  const rect = btn.getBoundingClientRect();
  openPositionMenu(key, { left: rect.left, bottom: rect.bottom }, zones, dock.defaultZoneOf(key));
}

/** ⇱ 位置选择器注入（v3）：声明 data-ext-float-dock 的浮窗面板，锚点 = ⛶（无则 ✕）左侧。
 *  兼读 data-ext-float-dock-default 注册默认落位（状态机 open 直达用，§2-B）。 */
function ensureDockBtn(panel: HTMLElement, key: string): void {
  const zones = dock.dockZonesOf(panel);
  const existing = panel.querySelector<HTMLElement>(`[${DOCK_BTN_ATTR}]`);
  if (!zones.length) {
    if (existing) existing.remove();
    return;
  }
  const defAttr = (panel.getAttribute("data-ext-float-dock-default") ?? "").trim();
  if (defAttr && zones.includes(defAttr)) dock.registerDefaultZone(key, defAttr);
  // zones 进集中注册表：TabBar ⇱ 菜单（面板未挂载时）以此为准（v3.1 置前/菜单统一）
  dock.registerZones(key, zones);
  const handle = floatHandleOf(panel);
  if (!handle || handle === panel) { if (existing) existing.remove(); return; }
  const anchor = panel.querySelector<HTMLElement>(`[${MAX_BTN_ATTR}]`) ?? closeButtonOf(handle);
  if (existing) {
    const inPlace = !anchor || (existing.parentElement === anchor.parentElement && existing.nextElementSibling === anchor);
    if (inPlace) return;
    existing.remove();
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute(DOCK_BTN_ATTR, "1");
  btn.setAttribute("data-piwe-float-h", "1");
  btn.textContent = "⇱";
  btn.title = "位置";
  btn.setAttribute("aria-label", "位置");
  btn.style.cssText = "background:none;border:none;color:var(--text-muted,#888);cursor:pointer;"
    + "font-size:12px;line-height:1;padding:2px 6px;flex-shrink:0;font-family:inherit;";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // v3：统一位置菜单（单 zone 也弹，Q2）——浮窗项 + 各 zone，当前态 ✓，default 标「默认」
    openDockMenu(panel, key, zones, btn);
  });
  // 插入：⛶/✕ 锚点左侧（同一父节点）；无锚点追加到把手末尾
  try {
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(btn, anchor);
    else handle.appendChild(btn);
  } catch { try { handle.appendChild(btn); } catch { /* ignore */ } }
}

/** 声明 dock 的面板：把手内 ✕ 点击 → present(close)（capture 拦截，React 委托不再收到）。 */
function installDockCloseInterceptor(panel: HTMLElement, key: string, disposers: Array<() => void>): void {
  if (!dock.dockZonesOf(panel).length) return;
  const onCloseCapture = (e: MouseEvent) => {
    const handle = floatHandleOf(panel);
    if (!handle) return;
    const closeBtn = closeButtonOf(handle);
    if (closeBtn && e.target instanceof Node && closeBtn.contains(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      dock.present(key, "close");
    }
  };
  panel.addEventListener("click", onCloseCapture, true);
  disposers.push(() => panel.removeEventListener("click", onCloseCapture, true));
}

function vw(): number { return window.innerWidth || document.documentElement.clientWidth || 1280; }
function vh(): number { return window.innerHeight || document.documentElement.clientHeight || 800; }

function attrPx(el: Element, name: string): number | null {
  const v = parseFloat(el.getAttribute(name) || "");
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 半透明遮罩判定：非 static 定位 + 盒子覆盖视口 ≥90% + background 为半透明色（0<alpha<1）。 */
function isDimMask(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.position === "static") return false;
  const r = el.getBoundingClientRect();
  if (r.width < vw() * 0.9 || r.height < vh() * 0.9) return false;
  const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  // 不透明 rgb(...)（3 段）= 整页宿主层（如 git-review 页面层 var(--bg)），不是遮罩，不碰
  if (parts.length < 4) return false;
  const a = parseFloat(parts[3]);
  return Number.isFinite(a) && a > 0 && a < 1;
}

/**
 * 遮罩自动去除（0.4.5）：扩展弹窗惯例是「全屏半透明遮罩层 > 面板」两层结构——面板浮起来了，
 * 外层遮罩却仍盖住整屏，挡住消息区点击还压暗页面。面板增强时把祖先链上的半透明全屏遮罩层
 * 打上 BACKDROP_ATTR（CSS：背景透明 + 点击穿透），弹窗即变成真正的非模态浮窗：后面消息照常
 * 可点。豁免：面板加 data-ext-float-keepmask="1"（真模态确认框等）。副作用说明：遮罩层自带的
 * 「点外关闭」从此不触发（点击穿透到页面了）——浮窗语义下以 ✕/ESC 关闭为准，属预期。
 */
function neutralizeMasks(panel: HTMLElement): void {
  const kv = (panel.getAttribute("data-ext-float-keepmask") || "").trim().toLowerCase();
  if (kv === "1" || kv === "true" || kv === "yes") return;
  let host: HTMLElement | null = panel.parentElement;
  while (host && host !== document.body) {
    // 已标记祖先 → 立即返回：scan 自愈每帧重入本函数，稳态下必须零 gBCR/gCS
    //（强制重排在大 DOM 流式会话 × 多面板下是 0.4.4 冻结事故同类燃料）
    if (host.hasAttribute(BACKDROP_ATTR)) return;
    if (isDimMask(host)) host.setAttribute(BACKDROP_ATTR, "1");
    host = host.parentElement;
  }
}

function clampState(s: FloatState, minW: number, minH: number): FloatState {
  const W = vw(), H = vh();
  const w = Math.max(minW, Math.min(s.w, W - 16));
  const h = Math.max(minH, Math.min(s.h, H - 16));
  // 至少留 80×40 在屏内（面板永远可抓回），允许部分拖出屏
  const x = Math.max(-(w - 80), Math.min(s.x, W - 80));
  const y = Math.max(0, Math.min(s.y, H - 40));
  return { x, y, w, h };
}

/** 初始定位出屏兜底（0.4.8）：clampState 之后任一方向仍出屏（左 x<0 / 右 x+w>W /
 *  上 y<0 / 下 y+h>H）→ 该轴拉回视口居中。仅用于「初始计算位（含 asis）」与「持久化
 *  恢复」——拖拽/缩放的部分出屏豁免（clampState 留 80×40 可抓回）是刻意设计，不经过这里。
 *  何时会出屏：① 面板宽/高于视口（data-ext-float-w 或渲染宽超屏）→ 居中 x=(W-w)/2 为负，
 *  clamp 压窄了 w 却不重算 x → 左切一截右侧空一截；② 宽屏存的位置在小屏恢复。w/h 已被
 *  clampState 压进视口（w ≤ W-16），居中后必全可见；极端窄屏（minW>W-16）时溢出均分两侧，
 *  已是可行域最优。 */
function centerIfOffscreen(s: FloatState): FloatState {
  const W = vw(), H = vh();
  const x = s.x < 0 || s.x + s.w > W ? Math.round((W - s.w) / 2) : s.x;
  const y = s.y < 0 || s.y + s.h > H ? Math.round((H - s.h) / 2) : s.y;
  return x === s.x && y === s.y ? s : { x, y, w: s.w, h: s.h };
}

/** 接管静态样式。autoh（自动高度）：不写 max-height:none/height——面板自己的 max-* 封顶继续生效，高度随内容。 */
function applyStatic(panel: HTMLElement, autoh: boolean): void {
  const st = panel.style;
  // important：扩展 React style 里声明过这些键时，重渲染不至于把接管的状态冲掉
  st.setProperty("position", "fixed", "important");
  st.setProperty("right", "auto", "important");
  st.setProperty("bottom", "auto", "important");
  st.setProperty("max-width", "none", "important");
  if (!autoh) st.setProperty("max-height", "none", "important");
  st.setProperty("margin", "0", "important");
  st.setProperty("box-sizing", "border-box", "important");
  // 布局基线：面板尺寸被拉大/缩小时内容不出圈——flex 列（标题栏自然高 + 内容区 flex:1 自己滚）
  // + 裁剪溢出。接入方约定：内容区包一层 overflow:auto + flex:1（参考 demo/模板）。
  st.setProperty("display", "flex", "important");
  st.setProperty("flex-direction", "column", "important");
  st.setProperty("overflow", "hidden", "important");
}

/** 动态盒模型（left/top/width/height）。拖动过程中不调——只写 transform，结束才提交。
 *  autoh：不写 height（高度随内容，由面板自己的 min/max-height 控制）。 */
function applyBox(panel: HTMLElement, s: FloatState, autoh: boolean): void {
  const st = panel.style;
  st.setProperty("left", s.x + "px", "important");
  st.setProperty("top", s.y + "px", "important");
  st.setProperty("width", s.w + "px", "important");
  if (autoh) st.setProperty("height", "auto", "important");
  else st.setProperty("height", s.h + "px", "important");
}

function persistenceKey(panel: HTMLElement): string | null {
  const k = panel.getAttribute("data-ext-float-key");
  if (k) return k;
  // 框架在 dialogs/pages 插槽包装层盖 data-ext-item（"extId:itemId"）——稳定身份
  const item = panel.closest("[data-ext-item]");
  return item ? item.getAttribute("data-ext-item") : null;
}

function loadSaved(key: string | null): FloatState | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const n = { x: +(o.x ?? NaN), y: +(o.y ?? NaN), w: +(o.w ?? NaN), h: +(o.h ?? NaN) };
    if (!Object.values(n).every(Number.isFinite)) return null;
    return n;
  } catch { return null; }
}

function saveState(key: string | null, s: FloatState): void {
  if (!key) return;
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(s)); } catch { /* 隐私模式等 */ }
}

function clearSaved(key: string | null): void {
  if (!key) return;
  try { localStorage.removeItem(LS_PREFIX + key); } catch { /* ignore */ }
}

// 点按置前：共享 z 计数器；面板自身 + 真正困住它的祖先层（遮罩层）一起抬。
let topZ = 3000;
function bringToFront(panel: HTMLElement): void {
  const cur = Number(getComputedStyle(panel).zIndex) || 0;
  if (cur >= topZ) return; // 已在最前（或扩展自管超大 z，如 extman 的 2147483644——不碰）
  topZ = Math.min(topZ + 1, 2147483000);
  panel.style.setProperty("z-index", String(topZ), "important");
  // 遮罩层是真正的堆叠兄弟——不抬它，面板提不到别的弹窗之上。
  // 「最近定位祖先」≠「层叠上下文」：relative + z-index:auto 的布局容器（宿主消息区根
  // .chat-content）不困后代 z-index，抬它 = 整块透明的消息区压过左栏(200)/右栏(250)，
  // 两区内容互相穿插——只抬真把面板关进层叠上下文的那一层（见 stacking.ts）。
  let host: HTMLElement | null = panel.parentElement;
  while (host && host !== document.body) {
    const cs = getComputedStyle(host);
    if (cs.position !== "static" || cs.transform !== "none") {
      if (createsStackingContext(cs)) {
        const hz = Number(cs.zIndex) || 0;
        if (hz < topZ) host.style.setProperty("z-index", String(topZ), "important");
      }
      break;
    }
    host = host.parentElement;
  }
}

/** 本实例已增强的面板 → 清理函数（单例拆除时逐个收尾，面板可被新实例干净重接管）。 */
const enhancedPanels = new Map<HTMLElement, () => void>();
/** 面板 → 最大化控制句柄（window.__piweFloat.toggleMax 等全局 API 的后端） */
const maxControls = new Map<HTMLElement, { toggle(): boolean; isMax(): boolean; isFull?(): boolean }>();
/** 窗口尺寸变化时夹回视口的回调注册表（元素离场自动剪除） */
const liveReclamps = new Set<() => void>();

/** 增强一个面板：定位接管 + 手势 + 持久化。返回清理函数（元素离场后调用无害）。 */
function enhancePanel(panel: HTMLElement): () => void {
  // 略：同面板重复增强防护（removeEnhanced 由调用方 scan 的 DONE 标记保证）
  const cleanup = enhancePanelInner(panel);
  enhancedPanels.set(panel, cleanup);
  return cleanup;
}

function enhancePanelInner(panel: HTMLElement): () => void {
  const modeRaw = (panel.getAttribute("data-ext-float") || "1").trim().toLowerCase();
  const drag = modeRaw === "1" || modeRaw === "drag" || modeRaw === "" || modeRaw === "true";
  const resize = modeRaw === "1" || modeRaw === "resize" || modeRaw === "" || modeRaw === "true";
  // autoh（自动高度）：高度不接管不持久化——随内容自适应（面板自己的 min/max-height 继续
  // 生效）。适用于「初始内容高度不定/异步增长」的弹窗（如模型向导首页）：固定高度会在内容
  // 变化后过期，出现永久滚动条。宽高缩放中高度方向停用（s 手柄不装，se 只调宽）。
  const autoh = panel.getAttribute("data-ext-float-autoh") === "1";

  const minW = attrPx(panel, "data-ext-float-min-w") || 320;
  const minH = attrPx(panel, "data-ext-float-min-h") || 200;
  const rect = panel.getBoundingClientRect();
  const initW = attrPx(panel, "data-ext-float-w") || (Math.round(rect.width) || 360);
  const initH = attrPx(panel, "data-ext-float-h") || (Math.round(rect.height) || 240);
  const key = persistenceKey(panel);

  // pos="asis"：初始位置取面板当前渲染位置（rect.left/top）——锚定下拉/提示浮层保持出现位，
  // 缺省=屏幕居中。只影响「无持久化时的首次位置」与「双击复位」目标；持久化恢复优先级更高。
  const posRaw = (panel.getAttribute("data-ext-float-pos") || "").trim().toLowerCase();
  // persist="0"：禁用位置持久化（不读不写）——锚定下拉每次打开回锚定位（拖动/缩放仅本次
  // 有效，关掉即忘），根治「宽屏存的位置在窄窗恢复 → clamp 只留 80px → 面板大半出屏」。
  const persistRaw = (panel.getAttribute("data-ext-float-persist") || "").trim().toLowerCase();
  const persistOn = !(persistRaw === "0" || persistRaw === "no" || persistRaw === "false" || persistRaw === "off");
  const initial = centerIfOffscreen(clampState(
    posRaw === "asis"
      ? { x: Math.round(rect.left), y: Math.round(rect.top), w: initW, h: initH }
      : { x: Math.round((vw() - initW) / 2), y: Math.round((vh() - initH) / 2), w: initW, h: initH },
    minW, minH,
  ));
  let state: FloatState = Object.assign({}, initial, (persistOn && loadSaved(key)) || {});
  state = centerIfOffscreen(clampState(state, minW, minH)); // 恢复位出屏同样拉回居中（0.4.8）

  // ── 全屏态（两种来源共用一套渲染）：
  //    ① 小屏自动：data-ext-float-full="small"/"1" —— 小屏（≤640px 宽）不浮窗；
  //    ② 手动最大化：window.__piweFloat.toggleMax(panel)（扩展自备按钮，float 管盒子）。
  //    任一激活即全屏：铺满视口、拖拽/缩放/持久化全停；全部退出才恢复浮窗与已存位置。──
  const fullRaw = (panel.getAttribute("data-ext-float-full") || "").trim().toLowerCase();
  const fullOnSmall = fullRaw === "small" || fullRaw === "1";
  let fullSmall = false;
  let maxed = false;
  const isFull = () => fullSmall || maxed;
  let mqFull: MediaQueryList | null = null;
  if (fullOnSmall && typeof window.matchMedia === "function") {
    mqFull = window.matchMedia(FULL_MQ);
    fullSmall = mqFull.matches;
  }
  // 全屏前面板自己的圆角（React inline style 写的，如 borderRadius:14）——退出全屏时还原
  let savedRadius: string | null = null;

  /** 把「是否应处于全屏」同步到 DOM（进：铺满视口 + 圆角归 0 + 藏手柄；退：摘掉覆盖样式，随后由 applyBox 恢复浮窗盒）。 */
  let fullApplied = false;
  /** 全屏手柄显隐：手动最大化时 ⛶/❐ 必须保持可见（否则有去无回），仅小屏全屏才藏它 */
  const setHandlesHidden = (hidden: boolean): void => {
    panel.querySelectorAll<HTMLElement>('[data-piwe-float-h="1"]').forEach((h) => {
      if (hidden && h.hasAttribute(MAX_BTN_ATTR) && maxed) { h.style.display = ""; return; }
      h.style.display = hidden ? "none" : "";
    });
  };
  const syncFull = (): void => {
    const want = isFull();
    if (want === fullApplied) return;
    fullApplied = want;
    const st = panel.style;
    if (want) {
      if (savedRadius === null) savedRadius = st.borderRadius || "";
      st.setProperty("left", "0", "important");
      st.setProperty("top", "0", "important");
      st.setProperty("width", "100%", "important");
      st.setProperty("height", "100%", "important"); // autoh 也铺满：面板有 flex 布局基线，内容区自己滚
      st.setProperty("max-height", "none", "important"); // autoh 面板自封的 max-* 在全屏下也放开，真正铺满
      st.setProperty("border-radius", "0", "important");
      st.setProperty("transform", "none", "important");
      setHandlesHidden(true);
    } else {
      if (autoh) st.removeProperty("max-height"); // autoh 恢复自封 max-*；非 autoh 还原 applyStatic 写入的 none
      else st.setProperty("max-height", "none", "important");
      st.removeProperty("border-radius");
      if (savedRadius) { try { st.borderRadius = savedRadius; } catch { /* ignore */ } }
      savedRadius = null;
      setHandlesHidden(false);
    }
  };

  /** 手动最大化开关（返回切换后的状态）。退出时若小屏全屏仍激活则保持全屏。 */
  const setMax = (v: boolean): boolean => {
    if (maxed === v) return maxed;
    maxed = v;
    const was = fullApplied;
    syncFull();
    if (was && !fullApplied) applyBox(panel, state, autoh); // 完全退出全屏：重写浮窗盒模型
    return maxed;
  };
  maxControls.set(panel, { toggle: () => setMax(!maxed), isMax: () => maxed, isFull: () => fullApplied });

  applyStatic(panel, autoh);
  syncFull();
  if (!fullApplied) applyBox(panel, state, autoh);
  neutralizeMasks(panel); // 遮罩自动去除（keepmask 豁免；不记 disposer——遮罩随弹窗关闭自然离场，热重载后新实例重新判定）
  panel.setAttribute(DONE_ATTR, "1");
  try { panel.setAttribute(LEGACY_DONE_ATTR, "1"); } catch { /* ignore */ } // 中和同页可能活着的旧实例

  const disposers: Array<() => void> = [];
  const persist = () => { if (!persistOn || isFull()) return; saveState(key, state); };
  disposers.push(() => maxControls.delete(panel)); // 面板清理时同步摘掉最大化句柄
  disposers.push(() => backLayers?.panelGone(panel)); // 返回层随面板清理释放
  // 本实例的面板级清理（单例拆除时逐面板调用）：手势监听 + 手柄元素 + 标记
  const removeHandles = () => panel.querySelectorAll('[data-piwe-float-h="1"]').forEach((h) => { try { h.remove(); } catch { /* ignore */ } });
  disposers.push(removeHandles);
  disposers.push(() => { try { panel.removeAttribute(DONE_ATTR); } catch { /* ignore */ } });

  // ── 缩放手柄（右/下/左缘 + 右下角，同 AI 窗）──
  if (resize) {
    const mk = (cls: string, dir: "se" | "e" | "s" | "w") => {
      if (autoh && dir === "s") return; // 自动高度：下缘无意义（高度跟内容），不装
      const hEl = document.createElement("div");
      hEl.className = "piwe-float-h " + cls;
      hEl.setAttribute("aria-hidden", "true");
      hEl.setAttribute("data-piwe-float-h", "1"); // 本实例的手柄标记（拆除/接管时区分）
      panel.appendChild(hEl);
      const orig: FloatState = { x: 0, y: 0, w: 0, h: 0 };
      disposers.push(attachGesture(hEl, {
        preventStart: true,
        onStart() { if (isFull()) return; orig.x = state.x; orig.y = state.y; orig.w = state.w; orig.h = state.h; panel.classList.add("piwe-float-dragging"); },
        onMove(dx: number, dy: number) {
          if (isFull()) return;
          let x = orig.x, y = orig.y, w = orig.w, h = orig.h;
          if (dir === "e" || dir === "se") w = orig.w + dx;
          if (dir === "w") { w = orig.w - dx; x = orig.x + dx; }
          if ((dir === "s" || dir === "se") && !autoh) h = orig.h + dy; // 自动高度：se 只调宽
          // 左缘夹最小宽：宽被夹住时左缘回跟（右缘不动）
          if (dir === "w" && w < minW) { x = orig.x + (orig.w - minW); w = minW; }
          state = clampState({ x, y, w, h }, minW, minH);
          applyBox(panel, state, autoh);
        },
        onEnd(moved) { panel.classList.remove("piwe-float-dragging"); if (moved) persist(); },
      }));
    };
    mk("piwe-float-se", "se");
    mk("piwe-float-e", "e");
    mk("piwe-float-s", "s");
    mk("piwe-float-w", "w");
  }

  // ── 拖拽（把手 = [data-ext-float-drag] 标记 / 第一个子元素（=标题栏契约）/ 面板自身）──
  if (drag) {
    const marked = panel.querySelector("[data-ext-float-drag]");
    const first = panel.firstElementChild instanceof HTMLElement ? panel.firstElementChild : null;
    const handle: HTMLElement = (marked as HTMLElement) || first || panel;
    try { handle.style.setProperty("cursor", "move"); } catch { /* ignore */ }
    try { handle.style.setProperty("touch-action", "none", "important"); } catch { /* ignore */ } // 触屏拖动不被滚动接管
    if (!handle.getAttribute("title")) handle.setAttribute("title", "拖动移动 · 双击复位");
    if (handle !== panel) { try { handle.style.setProperty("flex-shrink", "0"); } catch { /* ignore */ } } // 把手固定高度不被压缩
    const orig: FloatState = { x: 0, y: 0, w: 0, h: 0 };
    // ── 拖拽吸附（v0.5.2，§5.4）：floating 态手势照旧跑 transform，落点命中声明 zone 容器
    //    （宿主盖 data-ext-float-dock-zone 标注）→ 预览高亮 + 松手 present(dock:zone) 重建。
    //    rect 在 onStart 一次性缓存（零每帧 gBCR）；预览层单个全局元素复用。──
    const snapZones = dock.dockZonesOf(panel);
    let snapRects: Array<{ zone: string; rect: DOMRect }> | null = null;
    let snapHit: string | null = null;
    let snapPreview: HTMLElement | null = null;
    const snapPreviewRemove = () => {
      if (snapPreview) { try { snapPreview.remove(); } catch { /* ignore */ } snapPreview = null; }
      snapHit = null;
    };
    const snapPreviewShow = (rect: DOMRect) => {
      if (!snapPreview) {
        snapPreview = document.createElement("div");
        snapPreview.style.cssText = "position:fixed;z-index:2147483600;pointer-events:none;border-radius:10px;"
          + "background:color-mix(in srgb, var(--accent, #2563eb) 12%, transparent);"
          + "box-shadow: inset 0 0 0 2px var(--accent, #2563eb);transition: all 80ms ease;";
        document.body.appendChild(snapPreview);
      }
      const st = snapPreview.style;
      st.left = rect.left + "px"; st.top = rect.top + "px";
      st.width = rect.width + "px"; st.height = rect.height + "px";
    };
    const snapTrack = (e: PointerEvent) => {
      if (!snapRects) return;
      const hit = snapRects.find((z) => e.clientX >= z.rect.left && e.clientX <= z.rect.right && e.clientY >= z.rect.top && e.clientY <= z.rect.bottom) ?? null;
      const zone = hit?.zone ?? null;
      if (zone === snapHit) { if (hit) snapPreviewShow(hit.rect); return; }
      snapHit = zone;
      if (hit) snapPreviewShow(hit.rect); else snapPreviewRemove();
    };
    const snapStart = () => {
      if (!snapZones.length) return;
      snapRects = [];
      // 收集过滤（drag-drop-unify §3.1/§3.3）：精确 zone 命中，或通配落点 "sidebar"
      // 且面板声明了任意 sidebar:* zone（公共落点值 ≠ 面板私有 sidebar:<itemKey>，
      // 精确匹配收集不到——通配命中交 snapEnd 的 resolveDropZone 解析真实落位）
      const wantsSidebar = snapZones.some((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
      const hit = (zone: string) => snapZones.includes(zone) || (zone === SIDEBAR_DROP_ZONE && wantsSidebar);
      document.querySelectorAll<HTMLElement>("[data-ext-float-dock-zone]").forEach((el) => {
        const zone = el.getAttribute("data-ext-float-dock-zone") || "";
        if (!hit(zone)) return;
        snapRects!.push({ zone, rect: el.getBoundingClientRect() });
      });
      if (snapRects.length) window.addEventListener("pointermove", snapTrack, { passive: true });
    };
    const snapEnd = (): string | null => {
      window.removeEventListener("pointermove", snapTrack);
      // ⚠ 先读命中再清理：snapPreviewRemove 内部会清 snapHit——历史上先清理后读，
      // 命中值永远为 null，拖拽吸附松手从不入位（右栏/左栏全部失效的根因）
      const hit = snapHit;
      snapPreviewRemove();
      snapRects = null; snapHit = null;
      return hit;
    };
    disposers.push(attachGesture(handle, {
      threshold: 3, // 纯点击不被吞（把手上的按钮照常工作）
      filter: (e) => !(e.target && (e.target as HTMLElement).closest && (e.target as HTMLElement).closest(INTERACTIVE_SEL)), // 按钮/输入上按下不拖
      onStart() {
        if (isFull()) return;
        orig.x = state.x; orig.y = state.y;
        panel.classList.add("piwe-float-dragging");
        snapStart();
      },
      onMove(dx: number, dy: number) {
        if (isFull()) return;
        // 流畅关键：拖动只写 transform（合成层，每帧零重排零重绘）；结束才提交 left/top
        const t = clampState({ x: orig.x + dx, y: orig.y + dy, w: state.w, h: state.h }, minW, minH);
        state = t;
        panel.style.transform = "translate3d(" + (t.x - orig.x) + "px," + (t.y - orig.y) + "px,0)";
      },
      onEnd(moved) {
        panel.classList.remove("piwe-float-dragging");
        panel.style.transform = "";
        // 未过拖拽阈值（纯点击）不吸附：只清理追踪与预览
        const hitZone = moved ? snapEnd() : null;
        if (!moved) snapEnd();
        // 落点标记 zone 经 core 解析为面板真实落位（通配 "sidebar" → 面板自己的
        // sidebar:<itemKey>；未声明 sidebar 族则不入位）——统一入位支持（drag-drop-unify §3.3）
        const dropZone = hitZone ? resolveDropZone(hitZone, dock.dockZonesOf(panel)) : null;
        if (dropZone) { dock.present(key, "dock:" + dropZone); return; } // 落点即重建（浮窗 face 随 gate 卸载）
        if (!isFull()) applyBox(panel, state, autoh); // 一次性提交最终位置（单次回流）；全屏中不覆盖全屏盒
        if (moved && !isFull()) persist();
      },
    }));
    // 双击把手 = 复位（清持久化，回初始位置尺寸）
    const onDbl = (e: MouseEvent) => {
      if (isFull()) return; // 全屏态无「复位」语义
      if (e.target && (e.target as HTMLElement).closest && (e.target as HTMLElement).closest(INTERACTIVE_SEL)) return;
      clearSaved(key);
      state = Object.assign({}, initial);
      applyBox(panel, state, autoh);
    };
    handle.addEventListener("dblclick", onDbl);
    disposers.push(() => handle.removeEventListener("dblclick", onDbl));
  }

  // 手柄/把手在 syncFull 之后才创建——初始即全屏态（小屏打开/增强）时补一次隐藏（0.4.7）
  if (isFull()) setHandlesHidden(true);
  ensureMaxBtn(panel, fullApplied);
  ensureDockBtn(panel, key);
  installDockCloseInterceptor(panel, key, disposers);

  // 点按置前（capture：任何子元素按下都算）
  const onFront = () => bringToFront(panel);
  panel.addEventListener("pointerdown", onFront, true);
  disposers.push(() => panel.removeEventListener("pointerdown", onFront, true));

  // 窗口尺寸变化时夹回视口（reclamps 注册在全局列表，元素离场自动剪除）；小屏全屏期间不动
  const reclamp = () => { if (!isFull()) { state = clampState(state, minW, minH); applyBox(panel, state, autoh); } };
  liveReclamps.add(reclamp);
  disposers.push(() => liveReclamps.delete(reclamp));

  // ── 跨断点切换：进小屏 → 全屏；回大屏 → 恢复浮窗（已存位置原样回来；手动最大化仍激活则保持全屏）──
  if (mqFull) {
    const upd = () => {
      fullSmall = mqFull!.matches;
      const was = fullApplied;
      syncFull();
      if (was && !fullApplied) applyBox(panel, state, autoh); // 完全退出全屏：重写浮窗盒模型
    };
    if (mqFull.addEventListener) mqFull.addEventListener("change", upd);
    else mqFull.addListener(upd);
    disposers.push(() => {
      if (mqFull!.removeEventListener) mqFull!.removeEventListener("change", upd);
      else mqFull!.removeListener(upd);
    });
  }

  return () => disposers.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function scan(): void {
  // 清扫已离场面板：dialog 关闭后 DOM 节点离场，条目继续强引用面板（DOM 子树 +
  // 手势闭包）→ 内存泄漏。每次开关弹窗都会积累，直到扩展热重载才清。此处只需释放
  // 引用（节点已离场，无需调 cleanup；新开面板是新 DOM 节点，会被正常重接管）。
  if (enhancedPanels.size) {
    for (const p of enhancedPanels.keys()) {
      if (!p.isConnected) {
        backLayers?.panelGone(p);
        enhancedPanels.delete(p);
      }
    }
  }
  // 读写分离（2026-09-13 性能修复）：原实现逐面板「读 rect → enhance/bringToFront（写）→
  // 下一面板再读」= layout thrashing，页面加载期多面板扫描实测 44ms 强制重排（ForcedReflow）。
  // 现改三阶段：①legacy 清理（写）+ 收集；②批量读 rect（一个布局批次）；③批量 enhance/置前（写批次）。
  const pending: HTMLElement[] = [];
  for (const panel of document.querySelectorAll<HTMLElement>("[data-ext-float]")) {
    if (panel.hasAttribute(DONE_ATTR)) continue;
    // 被旧实例抢先增强过的面板（有旧标记无新标记）：摘掉旧手柄/标记后接管
    //（旧实例挂在把手上的监听拆不掉，但仅限本次会话已开过的面板；刷新后消失）
    if (panel.hasAttribute(LEGACY_DONE_ATTR)) {
      panel.querySelectorAll(".piwe-float-h").forEach((h) => { try { h.remove(); } catch { /* ignore */ } });
      try { panel.removeAttribute(LEGACY_DONE_ATTR); } catch { /* ignore */ }
    }
    pending.push(panel);
  }
  if (pending.length) {
    const rects = pending.map((p) => p.getBoundingClientRect()); // ② 单次布局批次（不与写交错）
    for (let i = 0; i < pending.length; i++) {
      const r = rects[i];
      if (r.width < 40 || r.height < 30) continue; // 未渲染/隐藏——等下一次 mutation 再试
      enhancePanel(pending[i]);
      // 出现置前：新挂载的面板（刚打开的弹窗）必须在已有浮层之上——否则先开的弹窗
      // 被 pointerdown 置前到 3001+（!important 连同遮罩宿主）后，后开的弹窗
      // （静态 zIndex ~292）会被压在后面（如 All Sessions → 归档查看器）。
      bringToFront(pending[i]);
    }
  }
  // 自愈：React 重渲染可能冲掉注入的最大化按钮，扫描时补回（MutationObserver 驱动，无轮询）。
  // 同时补跑遮罩判定：面板增强时遮罩可能尚未就位（入场动画中 rect 未铺满视口/晚一拍挂载），
  // 此处每帧重判一次补上（isDimMask 只读、命中后才写属性，同值重扫零写入，无观察者风暴风险）。
  for (const p of enhancedPanels.keys()) {
    ensureMaxBtn(p, maxControls.get(p)?.isFull?.() ?? false);
    neutralizeMasks(p);
    refreshBackLayer(p); // 小屏返回关闭（宿主服务缺席/大屏自动 no-op）
  }
  // 双开检测（§3.5 兜底）：同 key 双 face 同帧在 DOM → warn 一次（自愈由 gate 接入完成）
  for (const d of dupeCheck()) {
    if (dupeWarned.has(d.key)) continue;
    dupeWarned.add(d.key);
    console.warn(`[aiti-float] 双开检测：itemKey "${d.key}" 同时存在浮窗面板与停靠块——请接入 useGate 门控（dock 方案 §3.5）`);
  }
}

/** 已增强面板数（调试/自检出口用）。 */
export function panelCount(): number { return enhancedPanels.size; }

// ── 双开检测（v0.5.3，§3.5）：同 itemKey 同时存在浮窗面板 DOM 与 dock 嵌入块 DOM
//    （未接 gate 的历史代码才会双渲染）→ console.warn 一次 + dupeCheck() 可查。
const dupeWarned = new Set<string>();

/** 当前双开的 itemKey 清单（浮窗 face 与 dock body 同时在 DOM）。 */
export function dupeCheck(): Array<{ key: string }> {
  const dockKeys = new Set(
    [...document.querySelectorAll<HTMLElement>("[data-ext-float-dock-body]")]
      .map((el) => el.getAttribute("data-ext-float-dock-body"))
      .filter((k): k is string => Boolean(k)),
  );
  if (!dockKeys.size) return [];
  const out: Array<{ key: string }> = [];
  for (const p of enhancedPanels.keys()) {
    const k = persistenceKey(p);
    if (k && dockKeys.has(k)) out.push({ key: k });
  }
  return out;
}

/** 安装增强器（幂等，单例护栏）。返回卸载函数。 */
export function install(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};

  // ── 单例护栏：同页已有本扩展实例（热重载/重复 import 不卸载旧模块）→ 先完整拆除
  //    旧实例（observer/window 监听/逐面板手势+手柄+标记），否则两套手势各自
  //    setPointerCapture 互顶，拖一下就停（历史实锤）。拆除后面板由新实例重接管。
  interface InstanceSlot { teardown: () => void; version: string }
  let prevTeardown: (() => void) | null = null;
  try { prevTeardown = (window as any)[INSTANCE_SLOT] && (window as any)[INSTANCE_SLOT].teardown; } catch { /* ignore */ }
  if (typeof prevTeardown === "function") {
    try { prevTeardown(); } catch { /* ignore */ }
  }

  if (!document.getElementById(CSS_ID)) {
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  } else {
    // 热切换模块（extman/热重载）不刷新页面时：旧实例的 style 标签还在，必须同步规则文本，
    // 否则新版本新增的 CSS（如 0.4.5 遮罩规则）永不生效
    const style = document.getElementById(CSS_ID)!;
    if (style.textContent !== CSS_TEXT) style.textContent = CSS_TEXT;
  }

  // ── 小屏系统返回：退栈服务接入（面板层 + 位置菜单层）──────────────────
  // 只 acquire/release，不监听 popstate（历史退栈唯一写入口在宿主）；媒体断点变化由
  // 两个 manager 各自 onSmallScreenChange 重估（进小屏补注册 / 回大屏释放）。
  try { backMedia = typeof window.matchMedia === "function" ? window.matchMedia(FULL_MQ) : null; } catch { backMedia = null; }
  const backPortsBase = {
    getService: () => overlayBackService,
    isSmallScreen: () => backMedia?.matches ?? false,
    onSmallScreenChange: (cb: () => void) => {
      const mq = backMedia;
      if (!mq) return () => {};
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", cb);
        return () => mq.removeEventListener("change", cb);
      }
      mq.addListener(cb);
      return () => mq.removeListener(cb);
    },
  };
  backLayers = createBackLayerManager({ ...backPortsBase, dismiss: (panel) => dismissPanel(panel as HTMLElement) });
  menuBackLayers = createBackLayerManager({ ...backPortsBase, dismiss: () => closePositionMenu() });

  // 扫描调度：rAF 合并（每帧最多一次），且必然在浏览器绘制前执行 → 新面板首帧就是
  // 接管后的最终盒模型。⚠ 历史教训（0.4.3 回归）：曾用 queueMicrotask——scan() 自身的
  // DOM 写（ensureMaxBtn 的 style 同值写、handle 注入等）会再次触发 MutationObserver，
  // 回调又是微任务 → 微任务链永不落地 → 主线程彻底饿死（渲染/输入/CDP 全灭），
  // 大 DOM 页面（多消息会话）点任意按钮即硬冻结。rAF 每帧一次天然断链，且同为
  // 绘制前时机，零闪现保证不变。0.4.4。
  let microQueued = false;
  const scheduleScan = () => {
    if (microQueued) return;
    microQueued = true;
    const run = () => { microQueued = false; scan(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0); // 兜底：老环境退回宏任务（仅损失零闪现保证，功能不变）
  };


  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
  // ⛵ 命令事件监听（dock 方案 §5.2：外部经 COMMAND_EVENT 触发 present；teardown 反注册）
  const disposeCommand = dock.installCommandListener();
  // ⛵ TabBar ⇱ → 位置菜单（宿主只报 key+锚点；菜单数据 resolveMenuData，交互同浮窗 ⇱）
  const onDockMenu = (e: Event) => {
    const detail = (e as CustomEvent<{ key: string; rect?: { left: number; bottom: number } }>).detail;
    if (!detail?.key) return;
    const { zones, def } = resolveMenuData(detail.key);
    openPositionMenu(detail.key, detail.rect ?? { left: window.innerWidth / 2 - 70, bottom: 140 }, zones, def);
  };
  window.addEventListener(dock.DOCK_MENU_EVENT, onDockMenu);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      liveReclamps.forEach((fn) => { try { fn(); } catch { /* 面板可能已离场 */ } });
    }, 120);
  };
  window.addEventListener("resize", onResize);

  scan();

  // ── 全局 API（扩展自备最大化按钮时调用；float 管盒子，扩展只管按钮 UI）──
  //    window.__piweFloat.toggleMax(panelEl) → 返回切换后是否最大化
  //    window.__piweFloat.setMax(panelEl, v) / .isMax(panelEl)
  type MaxApi = { version: string; toggleMax(p: HTMLElement): boolean; setMax(p: HTMLElement, v: boolean): boolean; isMax(p: HTMLElement): boolean };
  const api: MaxApi = ((window as any).__piweFloat ||= {} as MaxApi);
  api.version = VERSION;
  // dock 展示状态机出口（_shared/ext-float-dock.ts 委托到这里；方案 §5.2）。
  // opts.auto 必须透传（恢复性入栈标记：宿主不据此展开小屏抽屉/右栏）——
  // 丢弃第三参数会让扩展经 _shared 传入的 auto 在 API 边界静默失效。
  (api as any).present = (k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }) => dock.present(k, mode, opts);
  (api as any).presented = (k: string) => dock.presented(k);
  (api as any).onPresentChange = (cb: (d: { key: string; state: string }) => void) => dock.onPresentChange(cb);
  (api as any).dockPref = (k: string) => dock.dockPref(k);
  (api as any).setPref = (k: string, pref: string) => dock.setPref(k, pref);
  (api as any).defaultZoneOf = (k: string) => dock.defaultZoneOf(k);
  (api as any).registerDefaultZone = (k: string, z: string) => dock.registerDefaultZone(k, z);
  (api as any).registerZones = (k: string, zs: string[]) => dock.registerZones(k, zs);
  (api as any).zonesOf = (k: string) => dock.zonesOf(k);
  // 「新窗口打开」能力注册表（面板声明；位置菜单显隐 B 图标）
  (api as any).registerWindowOpener = (k: string, fn: (() => void) | null) => dock.registerWindowOpener(k, fn);
  (api as any).windowOpenerOf = (k: string) => dock.windowOpenerOf(k);
  // 手动触发一轮扫描（调试/E2E：rAF 被 occlusion 节流的后台标签页里，mutation 驱动的
  // scheduleScan 不落地，新挂载浮窗面板会一直不被增强——真实前台标签页无此问题）
  (api as any).scan = () => scan();
  api.toggleMax = (p) => maxControls.get(p)?.toggle() ?? false;
  api.setMax = (p, v) => { const c = maxControls.get(p); if (c && c.isMax() !== v) c.toggle(); };
  api.isMax = (p) => maxControls.get(p)?.isMax() ?? false;
  api.isFull = (p) => maxControls.get(p)?.isFull?.() ?? false;

  // v3：安装完成广播（_shared 的 dock 头 store 探测据此从本地回落切到宿主服务）
  try { window.dispatchEvent(new Event(FLOAT_INSTALLED_EVENT)); } catch { /* ignore */ }

  const teardown = () => {
    mo.disconnect();
    disposeCommand();
    window.removeEventListener(dock.DOCK_MENU_EVENT, onDockMenu);
    window.removeEventListener("resize", onResize);
    if (resizeTimer) clearTimeout(resizeTimer);
    liveReclamps.clear();
    enhancedPanels.forEach((cleanup) => { try { cleanup(); } catch { /* ignore */ } });
    enhancedPanels.clear();
    closePositionMenu();
    backLayers?.dispose();
    backLayers = null;
    menuBackLayers?.dispose();
    menuBackLayers = null;
    backMedia = null;
    try { if ((window as any)[INSTANCE_SLOT] && (window as any)[INSTANCE_SLOT].teardown === teardown) delete (window as any)[INSTANCE_SLOT]; } catch { /* ignore */ }
  };
  try { (window as any)[INSTANCE_SLOT] = { teardown, version: VERSION }; } catch { /* ignore */ }
  return teardown;
}

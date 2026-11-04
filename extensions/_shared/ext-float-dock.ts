/**
 * _shared/ext-float-dock.ts — aiti-float dock 的扩展侧 **全量面**（重 UI：DockBody、
 * 头行工具条 hooks、faces 工厂）。状态机（present store）已下沉
 * ./ext-float-dock-core.ts（零 react）；壳用薄层 ./ext-float-dock-lite.ts（usePresent/
 * useGate + 状态机小 API）——拆包扩展的薄壳 import lite，不连带本文件的 UI 层
 * （P1-3，方案 pi-web-eager-ext-split-plan.md §6）。
 *
 * 本文件保持历史导入面不变：re-export core（状态机）+ lite（hooks），未拆包扩展
 * 照旧 `import { usePresent, DockBody, ... } from "../../../_shared/ext-float-dock"`。
 * 红线（dock 方案 §3.5）：gate 是唯一渲染开关——扩展不得再以自有 state 直接
 * 控制浮窗/嵌入两 face 的显隐。
 */
import { useEffect, useState, createElement as h } from "react";
import { clampToViewport, fixedOrigin } from "./popup-anchor";
import { DOCK_ICON_NODES, DOCK_ICON_SVG_ROOT_PROPS, type DockIconName } from "./dock-icons";

/** 图标元素（React/h 版；dock-icons 单一数据源）：stroke=2 线稿、currentColor。
 *  与 DOM 版 createDockIconSvg（core appendDockIconRow 内）同图形同尺寸。 */
export function dockIconEl(name: DockIconName, size = 16): unknown {
  return h("svg", { width: size, height: size, ...DOCK_ICON_SVG_ROOT_PROPS, "aria-hidden": "true" },
    ...DOCK_ICON_NODES[name].map((n, i) => h(n.tag, { key: i, ...n.attrs })));
}

/* ── 左栏区块 zone 泛化（sidebar 统一 dock 方案 §3.8）──
 * 纯状态层（present store + 折叠/排序/头行 store）在 ./ext-float-dock-core.ts
 * （零 react——aiti-float DockStack 同源消费）；这里 re-export 全量兼容面。
 * 规范 zone 值 = `sidebar:<itemKey>`，旧值 "sidebar-explorer" 永远兼容读。 */
export {
  type DockZone, type PresentState, type BlockAlign,
  type DockHeaderAction, type DockHeaderState, type DockHeaderCommands, type DockMenuItem,
  type DockHeaderRegistration, type DockHeaderStore, type DockHeaderVisibility,
  type DockIconRowItem, type PositionMenuItem,
  sidebarZoneOf, isSidebarDockState, splitBlockAlign,
  SIDEBAR_DROP_ZONE, resolveDropZone,
  SIDEBAR_COLLAPSE_PREFIX, SIDEBAR_ORDER_KEY,
  SIDEBAR_COLLAPSE_EVENT, SIDEBAR_ORDER_EVENT, SIDEBAR_MOVE_EVENT, FLOAT_INSTALLED_EVENT,
  readBlockCollapsed, writeBlockCollapsed, seedBlockCollapsedDefault,
  readDockOrder, writeDockOrder,
  effectiveBlockOrder, moveBlockKey, migrateLegacyCollapseKeys,
  createDockHeaderStore, localDockHeaderStore, DOCK_HEADER_PENDING_TTL,
  // present 状态机（P1-3 自本文件下沉 core）
  present, presentState, onPresentChange, dockPref,
  openFloat, closePanel, dockTo, dockToSidebar, undockToFloat,
  setDockPref, clearDockPref, seedDockDefault, declareDockZones,
  positionMenuItems, positionMenuModel, declareDockWindowOpener, dockWindowOpenerOf, DOCK_ZONE_LABELS,
} from "./ext-float-dock-core";
// hooks 薄层（P1-3 自本文件下沉 lite）
export { usePresent, useGate } from "./ext-float-dock-lite";
import {
  isSidebarDockState,
  readBlockCollapsed, writeBlockCollapsed,
  readDockOrder, localDockHeaderStore, FLOAT_INSTALLED_EVENT,
  SIDEBAR_COLLAPSE_EVENT, SIDEBAR_ORDER_EVENT, SIDEBAR_MOVE_EVENT, SIDEBAR_DROP_EVENT,
  floatApi, closePanel, positionMenuModel, seedDockDefault, declareDockZones, DOCK_ZONE_LABELS,
} from "./ext-float-dock-core";
import { usePresent, useGate } from "./ext-float-dock-lite";
import type { DockHeaderAction, DockHeaderCommands, DockHeaderState, DockHeaderStore, DockMenuItem, DockIconRowItem } from "./ext-float-dock-core";


/* ── 左栏区块栈：折叠/排序/迁移的 React 绑定见文件尾（useBlockCollapsed/useDockOrder）；
 *    纯状态层在 ./ext-float-dock-core.ts。此处只留位置菜单项构建（依赖 present 动作糖）。── */

export function usePosition(itemKey: string, zones: DockZone[], defaultZone?: DockZone) {
  const state = usePresent(itemKey);
  return { state, zones, defaultZone, labels: DOCK_ZONE_LABELS };
}


/** 停靠 face 头行（chrome="section"，左栏区块统一头行 v4）：展开箭头 + 标题 + 计数 +
 *  **单一 ⋮ 功能菜单按钮**（折叠/位置/上移/下移/移除/关闭按上下文显隐——方案评审 6 拍板
 *  「禁多按钮多位置差异」，⇱⇲✕ 三钮收编进一个菜单）。chrome="tab"（右栏 TabBar）v3.1 起
 *  **不渲染头行**——页签行已有 ⇱（位置菜单）+ ✕，双击 = 拉回浮窗。 */
/* ── dock 头工具条：服务/本地 store 探测 + hooks（v3；方案 §2.3/§2.7） ── */

/** 当前 store：aiti-float 服务（跨 bundle 单例）优先；缺席回落本地 store（同 bundle）。 */
export function headerStore(): DockHeaderStore {
  const api = floatApi() as (FloatApi & { dockHeader?: DockHeaderStore }) | null;
  const svc = api?.dockHeader;
  return svc && typeof svc.register === "function" ? svc : localDockHeaderStore();
}

/** 请求 dock 头命令（face 按钮 → 内容实现）：命中即执行；未命中 → 展开区块 + 排队（TTL 10s）。 */
export function requestDockCommand(itemKey: string, actionId: string, payload?: unknown): boolean {
  return headerStore().request(itemKey, actionId, payload);
}

/** store 上线重解析 tick（服务安装事件）：hook/订阅把它计入 effect 依赖即可换绑。 */
export function useDockHeaderStoreTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((v) => v + 1);
    window.addEventListener(FLOAT_INSTALLED_EVENT, on);
    return () => window.removeEventListener(FLOAT_INSTALLED_EVENT, on);
  }, []);
  return tick;
}

/** 内容注册命令实现（每次渲染更新引用；卸载清空）。 */
export function useDockCommands(itemKey: string | undefined, commands: DockHeaderCommands | null): void {
  const tick = useDockHeaderStoreTick();
  useEffect(() => {
    if (!itemKey) return;
    try { headerStore().register(itemKey, { commands }); } catch { /* ignore */ }
  });
  useEffect(() => {
    if (!itemKey) return;
    return () => { try { headerStore().register(itemKey, { commands: null }); } catch { /* ignore */ } };
  }, [itemKey, tick]);
}

/** 内容上报状态（active/done/root 等纯数据；签名变化才通知）。 */
export function useDockHeaderState(itemKey: string | undefined, state: DockHeaderState | null): void {
  const tick = useDockHeaderStoreTick();
  useEffect(() => {
    if (!itemKey) return;
    try { headerStore().register(itemKey, { state }); } catch { /* ignore */ }
  });
  useEffect(() => {
    if (!itemKey) return;
    return () => { try { headerStore().register(itemKey, { state: null }); } catch { /* ignore */ } };
  }, [itemKey, tick]);
}

/** 内容注册 ⋮ 菜单附加项（head/sep/item；复杂文件操作菜单等）。 */
export function useDockHeaderMenuItems(itemKey: string | undefined, menuItems: DockMenuItem[] | null): void {
  const tick = useDockHeaderStoreTick();
  useEffect(() => {
    if (!itemKey) return;
    try { headerStore().register(itemKey, { menuItems }); } catch { /* ignore */ }
  });
  useEffect(() => {
    if (!itemKey) return;
    return () => { try { headerStore().register(itemKey, { menuItems: null }); } catch { /* ignore */ } };
  }, [itemKey, tick]);
}

/** face 读取内容上报的状态（订阅重渲染）。 */
export function useDockHeaderStateOf(itemKey: string | undefined): DockHeaderState {
  const tick = useDockHeaderStoreTick();
  const [, setVer] = useState(0);
  useEffect(() => {
    if (!itemKey) return;
    const s = headerStore();
    return s.subscribe(itemKey, () => setVer((v) => v + 1));
  }, [itemKey, tick]);
  return itemKey ? headerStore().stateOf(itemKey) : {};
}

/** DockBody 内部：订阅本 itemKey 的 actions/menuItems（签名变化触发重渲染）。 */
function useDockHeaderStoreData(itemKey: string): { actions: DockHeaderAction[] | null; menuItems: DockMenuItem[] | null; hasCommands: boolean } {
  const tick = useDockHeaderStoreTick();
  const [, setVer] = useState(0);
  useEffect(() => {
    const s = headerStore();
    return s.subscribe(itemKey, () => setVer((v) => v + 1));
  }, [itemKey, tick]);
  const s = headerStore();
  return { actions: s.actionsOf(itemKey), menuItems: s.menuItemsOf(itemKey), hasCommands: !!s.commandsOf(itemKey) };
}

/** 合并按钮来源：face prop 优先 + 服务/本地 store 补位（按 id 去重，保持声明序）。 */
function mergeHeaderActions(local: DockHeaderAction[] | null | undefined, fromStore: DockHeaderAction[] | null): DockHeaderAction[] {
  const out: DockHeaderAction[] = [];
  const seen = new Set<string>();
  for (const a of [...(local ?? []), ...(fromStore ?? [])]) {
    if (!a || typeof a.id !== "string" || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/** 菜单渲染行（内部统一形态；head/sep/item）。 */
type DockMenuRow =
  | { type: "head"; label: string }
  | { type: "sep" }
  | { type: "item"; label: string; icon?: unknown; badge?: number | string; hint?: string; active?: boolean; alwaysRun?: boolean; disabled?: boolean; run: () => void }
  | { type: "icons"; label?: string; icon?: unknown; items: DockIconRowItem[] };

/** 停靠面板头行（chrome="section"，左栏区块统一头行 v3）：展开箭头 + 标题位 +
 *  **声明式业务按钮**（自适应宽度；放不下自动进 ⋮「工具」组）+ **常驻 detach**（位置菜单）+
 *  **单一 ⋮ 功能菜单**（工具溢出 / 内容注册菜单项 / 区块操作三段；长菜单可滚）。
 *  chrome="tab"（右栏 TabBar）不渲染头行——页签行已有 ⇱ + ✕。
 *  折叠保挂：内容注册过命令（曾挂载）时，折叠保留 children（display:none）——头行按钮
 *  状态准确、点击零等待；未注册则折叠不挂载（保住懒加载）。 */
export function DockBody(props: {
  itemKey: string;
  zone?: DockZone;
  title?: string;
  /** "section"：统一 ⋮ 头行（左栏区块）；"tab"：无头行（控件在宿主 TabBar 页签上） */
  chrome?: "section" | "tab";
  /** 可停靠位置全集（detach 位置菜单；缺省 [zone]——单 zone 面板无需传） */
  zones?: DockZone[];
  /** 扩展声明默认落位（菜单尾标「默认」，纯展示） */
  defaultZone?: DockZone;
  /** 区块身份（折叠/排序记忆 key；缺省 = itemKey） */
  blockKey?: string;
  /** 折叠态外部受控（DockStack 容器传入） */
  collapsed?: boolean;
  onToggleCollapsed?: (next: boolean) => void;
  /** 计数徽标（如子代理数） */
  count?: number;
  /** 常驻区块（reserved）：无 detach/关闭菜单项；可带 onRemove（多实例「移除本实例」） */
  kind?: "dockable" | "reserved";
  /** 多实例区块「移除本实例」 */
  onRemove?: () => void;
  /** 「关闭」动作覆盖（缺省 closePanel(itemKey)） */
  onClose?: () => void;
  /** 「新窗口打开」能力（可选）：提供时位置菜单优先出该项（图标排最前，B 图形）；
   *  不提供则回退注册表（declareDockWindowOpener），仍无则不显示（不支持的面板）。 */
  onNewWindow?: () => void;
  /** 扩展附加菜单项（钉住等多实例专属动作；插在区块操作段） */
  extraMenuItems?: Array<{ label: string; icon?: unknown; hint?: string; active?: boolean; alwaysRun?: boolean; run: () => void }>;
  /** 标题位自定义（如文件夹的目录切换器）；提供时替换标题文本（title 仍用于 aria/兜底） */
  renderTitle?: () => unknown;
  /** 声明式头行按钮（face 本地声明；与服务/本地 store 注册的 buttons 合并，prop 优先按 id 去重） */
  headerActions?: DockHeaderAction[];
  children: any;
}) {
  const { itemKey, zone, title, chrome = "section", zones, defaultZone, children } = props;
  const kind = props.kind ?? "dockable";
  const blockKey = props.blockKey ?? itemKey;
  const selfCollapsed = useState<boolean>(() => readBlockCollapsed(blockKey));
  const collapsed = props.collapsed ?? selfCollapsed[0];
  // 外部折叠变更（旧 key 迁移 / 跨 tab / 容器）→ 同步自持态（受控 props 时不跟随）
  const setSelfCollapsed = selfCollapsed[1];
  useEffect(() => {
    if (props.collapsed !== undefined) return;
    const sync = () => setSelfCollapsed(readBlockCollapsed(blockKey));
    window.addEventListener(SIDEBAR_COLLAPSE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(SIDEBAR_COLLAPSE_EVENT, sync); window.removeEventListener("storage", sync); };
  }, [blockKey, props.collapsed]);
  const setCollapsed = (next: boolean) => {
    setSelfCollapsed(next);
    writeBlockCollapsed(blockKey, next); // 单一事实源 + 广播（Stack 同步栈格 flex）
    props.onToggleCollapsed?.(next);
  };
  // ── store 数据（内容注册的 actions/menuItems；签名变化重渲染）──
  const storeData = useDockHeaderStoreData(itemKey);
  // ⋮ 主菜单 / ⇱ 位置菜单共用一套 fixed 弹层（v3：菜单可能很长——maxHeight+overflowY，
  // 内部滚动豁免「任意容器滚动即关」；点外 mousedown / 菜单外滚动仍关）。
  const [menu, setMenu] = useState<{ kind: "position" | "main"; anchor: HTMLElement } | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);
  const [menuBtnEl, setMenuBtnEl] = useState<HTMLElement | null>(null);
  const [posBtnEl, setPosBtnEl] = useState<HTMLElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!menu || !menuEl || !menu.anchor) return;
    const b = menu.anchor.getBoundingClientRect();
    const m = menuEl.getBoundingClientRect();
    const gap = 4, pad = 8;
    let top = b.bottom + gap;
    const below = window.innerHeight - pad - top;
    const above = b.top - gap - pad;
    if (m.height > below && above > below) top = b.top - gap - m.height; // 上翻
    const c = clampToViewport(b.right - m.width, top, m.width, m.height, pad);
    const o = fixedOrigin(menuEl);
    const next = { left: c.left - o.x, top: c.top - o.y };
    setMenuPos((cur) => (cur && cur.left === next.left && cur.top === next.top) ? cur : next);
  }, [menu, menuEl]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: any) => {
      const t = e.target as Node | null;
      if (t && menuEl?.contains(t)) return;
      if (t && menu.anchor?.contains(t)) return;
      setMenu(null);
    };
    const onScroll = (e: any) => {
      // 菜单内部滚动豁免（长菜单必须可滚）；菜单外任意容器滚动即关（fixed 弹层滞留旧位=错位）
      if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, menuEl]);
  // ── 自适应：头行可用宽度 → 可见业务按钮数（ResizeObserver + window resize；无轮询）──
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [fitCount, setFitCount] = useState(4);
  useEffect(() => {
    if (!headerEl) return;
    const calc = () => {
      const w = headerEl.clientWidth || 0;
      if (w <= 0) return;
      // 固定占用估算：padding16 + 箭头22 + 标题最小56 + detach24 + ⋮24 + 间隙12
      const fixed = 154;
      const n = Math.max(0, Math.min(6, Math.floor((w - fixed) / 27)));
      setFitCount((cur) => (cur === n ? cur : n));
    };
    calc();
    let ro: any = null;
    try { if (typeof ResizeObserver === "function") { ro = new ResizeObserver(calc); ro.observe(headerEl); } } catch { /* ignore */ }
    window.addEventListener("resize", calc);
    return () => { try { if (ro) ro.disconnect(); } catch { /* ignore */ } window.removeEventListener("resize", calc); };
  }, [headerEl]);
  const state = usePresent(itemKey);
  const allZones = zones && zones.length ? zones : (zone ? [zone] : []);
  const showDetach = kind === "dockable" && chrome === "section" && allZones.length > 0;
  // .ts 文件（跨扩展共享不保证 jsx-runtime）→ 用 createElement 而非 JSX 语法
  const btnBase: any = {
    background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer",
    fontSize: 11, lineHeight: 1, padding: "2px 5px", flexShrink: 0, fontFamily: "inherit",
  };
  // ── 业务按钮：合并来源 → 折叠过滤 visibility → 自适应截断（其余进 ⋮「工具」组）──
  const allActions = mergeHeaderActions(props.headerActions, storeData.actions);
  const eligible = allActions.filter((a) => !collapsed || (a.visibility ?? "always") !== "expanded");
  const shownActions = eligible.slice(0, fitCount);
  const overflowActions = eligible.slice(fitCount);
  const actionBtn = (a: DockHeaderAction) => h("button", {
    key: a.id, type: "button", title: a.title, "aria-label": a.title, disabled: a.disabled === true,
    style: {
      ...btnBase, position: "relative" as const,
      color: a.done ? "#4ade80" : a.active ? "var(--accent, #2563eb)" : "var(--text-muted, #888)",
      opacity: a.disabled ? 0.5 : 1, cursor: a.disabled ? "default" : "pointer",
    },
    onClick: (e: any) => { if (a.disabled !== true) a.onClick(e); },
  },
    a.icon ? h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center" } }, a.icon) : h("span", { style: { fontSize: 12, fontWeight: 700, lineHeight: 1 } }, "•"),
    (a.badge !== undefined && a.badge !== null && a.badge !== "") ? h("span", {
      style: { position: "absolute" as const, top: -5, right: -4, fontSize: 9, lineHeight: "13px", color: "var(--text-muted, #888)", background: "var(--bg-panel, #1a1a1a)", border: "1px solid var(--border, #444)", borderRadius: 7, padding: "0 3px" },
    }, String(a.badge)) : null);
  // ── ⋮ 主菜单（三段：工具溢出 / 内容注册菜单项 / 区块操作）──
  const buildMainMenu = (): DockMenuRow[] => {
    const out: DockMenuRow[] = [];
    if (overflowActions.length > 0) {
      out.push({ type: "head", label: "工具" });
      for (const a of overflowActions) out.push({ type: "item", label: a.title, icon: a.icon, badge: a.badge, active: a.active, alwaysRun: true, disabled: a.disabled, run: a.onClick });
    }
    if (storeData.menuItems && storeData.menuItems.length > 0) {
      if (out.length > 0) out.push({ type: "sep" });
      for (const m of storeData.menuItems) {
        if (m.kind === "head") out.push({ type: "head", label: m.label });
        else if (m.kind === "sep") out.push({ type: "sep" });
        else out.push({ type: "item", label: m.label, icon: m.icon, hint: m.hint, active: m.active, alwaysRun: m.alwaysRun, disabled: m.disabled, run: m.run });
      }
    }
    const ops: DockMenuRow[] = [];
    if (chrome === "section") {
      // 单行「移动」（2026-09-15 用户拍板回归 §3.5 图标排形态）：行首对角双箭头图标（move-diagonal-2，
      // 左上+右下）+ 行名呈 icon+text，与区块段其余行呼应；右侧 chevron-up/down 即时上移/下移。
      ops.push({ type: "icons", label: "移动", icon: dockIconEl("move-diagonal-2", 13), items: [
        { key: "move-up", icon: "chevron-up", label: "上移", run: () => requestBlockMove(blockKey, -1) },
        { key: "move-down", icon: "chevron-down", label: "下移", run: () => requestBlockMove(blockKey, 1) },
      ] });
    }
    if (kind === "reserved" && typeof props.onRemove === "function") {
      ops.push({ type: "item", label: "移除本实例", icon: dockIconEl("trash", 13), run: () => props.onRemove!() });
    }
    if (Array.isArray(props.extraMenuItems)) {
      for (const m of props.extraMenuItems) ops.push({ type: "item", label: m.label, icon: m.icon, hint: m.hint, active: m.active, alwaysRun: m.alwaysRun, run: m.run });
    }
    if (kind === "dockable" && chrome === "section") {
      ops.push({ type: "item", label: "关闭", icon: dockIconEl("x", 13), run: () => (props.onClose ? props.onClose() : closePanel(itemKey)) });
    }
    if (ops.length > 0) {
      if (out.length > 0) out.push({ type: "sep" });
      out.push({ type: "head", label: "区块" });
      out.push(...ops);
    }
    return out;
  };
  const positionRows: DockMenuRow[] = menu?.kind === "position"
    // v5 图标排（方案 §3.4）：统一模型（浮窗 → 各停靠位）+ 一行无歧义方位图标
    ? [{ type: "icons" as const, label: "停靠方位", items: positionMenuModel(itemKey, allZones, defaultZone, state, { onNewWindow: props.onNewWindow }) }]
    : [];
  const menuRows: DockMenuRow[] = menu?.kind === "position" ? positionRows : (menu?.kind === "main" ? buildMainMenu() : []);
  const renderMenuRow = (it: DockMenuRow, i: number) => {
    if (it.type === "sep") return h("div", { key: `sep-${i}`, style: { height: 1, background: "var(--border, #444)", margin: "3px 4px", opacity: 0.7, flexShrink: 0 } });
    if (it.type === "head") return h("div", { key: `head-${i}`, style: { fontSize: 10, color: "var(--text-dim, #888)", fontWeight: 600, padding: "4px 10px 2px", letterSpacing: 0.3, userSelect: "none", whiteSpace: "nowrap" as const } }, it.label);
    // v5 图标排（方案 §3.4/§3.5）：一行「名称 + 右对齐图标组」（参照菜单样式：名称左、
    // 图标右对齐；当前态高亮锁定、默认位圆点、hover tooltip）；数值与 DOM 版一致。
    if (it.type === "icons") return h("div", {
      key: `icons-${i}`, role: "group", "data-ext-dock-icon-row": "1",
      style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "5px 10px", flexShrink: 0 },
    },
      it.label ? h("span", { key: "label", "data-ext-dock-icon-row-label": "1",
        // 行首图标（可选）：带图标 = 动作行（正文字色，与其余 icon+text 行同款）；
        // 无图标 = 纯说明名（dim，位置菜单「停靠方位」标题原样）。
        style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
          color: it.icon ? "var(--text, #ddd)" : "var(--text-dim, #888)", flexShrink: 0, userSelect: "none" as const, whiteSpace: "nowrap" as const } },
        it.icon ? h("span", { style: { display: "inline-flex", flexShrink: 0 } }, it.icon) : null,
        it.label) : null,
      h("div", { key: "group", "data-ext-dock-icon-group": "1",
        style: { display: "flex", gap: 6, marginLeft: "auto", flexShrink: 0 } },
        ...it.items.map((x, j) => {
          const isRadio = x.active === true || x.active === false;
          const tip = x.isDefault ? `${x.label}（默认）` : x.label;
          return h("button", {
            key: `icon-${j}`, type: "button",
            role: isRadio ? "menuitemradio" : "menuitem",
            ...(isRadio ? { "aria-checked": x.active ? "true" : "false" } : {}),
            title: tip, "aria-label": tip, "data-ext-dock-icon": x.key,
            style: {
              position: "relative" as const, width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center",
              border: "none", borderRadius: 6, padding: 0, fontFamily: "inherit",
              cursor: x.active ? "default" : "pointer",
              background: x.active ? "var(--bg-selected, #2a2a2a)" : "none",
              color: x.active ? "var(--accent, #2563eb)" : "var(--text-muted, #888)",
            },
            onClick: () => { if (x.active) return; setMenu(null); x.run(); },
            onMouseEnter: (e: any) => { if (!x.active) { e.currentTarget.style.background = "var(--bg-hover, #262626)"; e.currentTarget.style.color = "var(--text, #ddd)"; } },
            onMouseLeave: (e: any) => { if (!x.active) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted, #888)"; } },
          },
            dockIconEl(x.icon, 16),
            x.isDefault ? h("span", { key: "dot", "data-ext-dock-icon-default": "1", style: { position: "absolute" as const, top: 3, right: 3, width: 4, height: 4, borderRadius: "50%", background: "var(--accent, #2563eb)", pointerEvents: "none" as const } }) : null,
          );
        })),
    );
    const disabled = it.disabled === true;
    const locked = it.active === true && it.alwaysRun !== true;
    return h("button", {
      key: `item-${i}`, type: "button", role: "menuitem", disabled,
      style: {
        background: "none", border: "none", cursor: disabled || locked ? "default" : "pointer", fontSize: 12,
        padding: "6px 12px", textAlign: "left" as const, borderRadius: 6, fontFamily: "inherit",
        color: it.active ? "var(--accent, #2563eb)" : "var(--text, #ddd)", display: "flex", alignItems: "center", gap: 6,
        opacity: disabled ? 0.5 : 1, flexShrink: 0,
      },
      onClick: () => { setMenu(null); if (!locked) it.run(); },
      onKeyDown: (e: any) => { if (e.key === "Escape") setMenu(null); },
    },
      it.icon ? h("span", { style: { width: 14, display: "inline-flex", justifyContent: "center", flexShrink: 0 } }, it.icon) : null,
      (it.active ? "✓ " : "") + it.label,
      it.badge !== undefined && it.badge !== null && it.badge !== "" ? h("span", { style: { marginLeft: "auto", fontSize: 10, color: "var(--text-muted, #888)", border: "1px solid var(--border, #444)", borderRadius: 6, padding: "0 4px" } }, String(it.badge)) : null,
      it.hint ? h("span", { style: { marginLeft: "auto", fontSize: 10, color: "var(--text-muted, #888)", border: "1px solid var(--border, #444)", borderRadius: 4, padding: "0 4px" } }, it.hint) : null,
    );
  };
  const menuNode = menu ? h("div", {
    ref: setMenuEl,
    role: "menu",
    style: {
      position: "fixed", zIndex: 2147483600, background: "var(--bg-panel, #1a1a1a)",
      border: "1px solid var(--border, #444)", borderRadius: 8, padding: 4, display: "flex", flexDirection: "column", gap: 2,
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)", minWidth: menu?.kind === "position" ? 190 : 150, maxWidth: "calc(100vw - 16px)",
      // 长菜单滚动契约（v3）：视口内可滚 + 防滚动穿透（内部滚动不触发「容器滚动即关」）
      maxHeight: "min(70vh, calc(100vh - 16px))", overflowY: "auto" as const, overscrollBehavior: "contain" as const,
      // 首帧离屏（布局期测量后落位，绘制前同步无闪烁）
      ...(menuPos ? { left: menuPos.left, top: menuPos.top } : { left: -99999, top: -99999 }),
    },
    onMouseLeave: () => setMenu(null),
  }, menuRows.map(renderMenuRow)) : null;
  const toggleCollapsed = () => setCollapsed(!collapsed);
  // 排序 v2：头行 = HTML5 拖拽把手。dragged key 双通道传递：dataTransfer（跨 bundle，
  // drop 阶段可读）+ 模块级 dragKey（同 bundle 实时读——dragover 阶段 dataTransfer 受
  // 保护读不到，用于抑制自拖高亮；自拖拽必然同 bundle，故可靠）。drop 前/后半区决定
  // 插入位；键盘路径 = ⋮ 上移/下移。
  const onDragStart = (e: any) => {
    if (e.target && typeof e.target.closest === "function" && e.target.closest("button")) { e.preventDefault(); return; }
    dragKey = blockKey;
    try {
      e.dataTransfer.setData("application/x-pi-dock", blockKey);
      e.dataTransfer.effectAllowed = "move";
    } catch { /* ignore */ }
  };
  const isDockDrag = (e: any) => { try { return [...(e.dataTransfer?.types ?? [])].includes("application/x-pi-dock"); } catch { return false; } };
  const dropMark = (e: any, on: boolean) => {
    const el = e.currentTarget as HTMLElement;
    if (!el) return;
    el.classList.remove("pi-dock-drop-before", "pi-dock-drop-after");
    if (on) el.classList.add((e.clientY - el.getBoundingClientRect().top) < el.getBoundingClientRect().height / 2 ? "pi-dock-drop-before" : "pi-dock-drop-after");
  };
  const onDrop = (e: any) => {
    if (!isDockDrag(e)) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.classList.remove("pi-dock-drop-before", "pi-dock-drop-after");
    let dragged = "";
    try { dragged = e.dataTransfer.getData("application/x-pi-dock") || ""; } catch { /* ignore */ }
    if (!dragged) dragged = dragKey || "";
    if (!dragged || dragged === blockKey) return;
    const r = el.getBoundingClientRect();
    requestBlockDrop(dragged, blockKey, (e.clientY - r.top) < r.height / 2);
  };
  const headerProps: any = { ref: setHeaderEl, style: { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--border, #333)", flexShrink: 0, minWidth: 0 }, onClick: (e: any) => { if (e.target && typeof e.target.closest === "function" && e.target.closest("button")) return; toggleCollapsed(); } };
  if (chrome === "section") {
    headerProps.draggable = true;
    headerProps.title = "拖动排序";
    headerProps.onDragStart = onDragStart;
    headerProps.onDragOver = (e: any) => { if (isDockDrag(e) && dragKey !== blockKey) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dropMark(e, true); } };
    headerProps.onDragLeave = (e: any) => { try { if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return; } catch { /* ignore */ } dropMark(e, false); };
    headerProps.onDrop = onDrop;
    headerProps.onDragEnd = () => {
      dragKey = null;
      document.querySelectorAll(".pi-dock-drop-before, .pi-dock-drop-after").forEach((el) => el.classList.remove("pi-dock-drop-before", "pi-dock-drop-after"));
    };
  }
  const titleNode = props.renderTitle
    ? h("span", { style: { minWidth: 0, flex: "0 1 auto", display: "inline-flex", alignItems: "center" } }, props.renderTitle())
    : h("span", { style: { fontSize: 11, fontWeight: 600, color: "var(--text-muted, #999)", letterSpacing: "0.04em", textTransform: "uppercase" as const, flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, minWidth: 0 } }, title ?? "");
  // 折叠保挂（v3）：内容注册过命令（曾挂载）→ 折叠保留 children（隐藏），按钮状态与命令即时可用
  const keepAlive = collapsed && storeData.hasCommands;
  return h("div", {
    "data-ext-float-dock-body": itemKey,
    "data-ext-item": itemKey,
    "data-ext-dock-block": blockKey,
    // 根上带声明属性：TabBar ⇱ 菜单在 face 挂载时可直接读（注册表兜底优先）
    "data-ext-float-dock": allZones.join(" "),
    ...(defaultZone ? { "data-ext-float-dock-default": defaultZone } : {}),
    // 注册按钮数（e2e/调试断言用）：当前头行可见 / 溢出
    "data-ext-dock-actions": String(shownActions.length),
    "data-ext-dock-actions-overflow": String(overflowActions.length),
    style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", position: "relative" },
  },
    chrome === "section" && h("div", headerProps,
      h("button", {
        type: "button", title: collapsed ? "展开" : "折叠", "aria-label": (title ?? "区块") + (collapsed ? " 展开" : " 折叠"),
        "aria-expanded": collapsed ? "false" : "true", style: { ...btnBase, display: "flex", alignItems: "center" },
        onClick: toggleCollapsed,
      },
        h("svg", { width: 9, height: 9, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
          style: { transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s", flexShrink: 0 } },
          h("polyline", { points: "3 2 7 5 3 8" })),
      ),
      titleNode,
      typeof props.count === "number" && h("span", { style: { color: "var(--text-dim, #777)", fontWeight: 400, fontSize: 10, flexShrink: 0 } }, `(${props.count})`),
      h("span", { style: { flex: 1, minWidth: 0 } }),
      ...shownActions.map(actionBtn),
      showDetach ? h("span", { style: { position: "relative", display: "inline-flex", flexShrink: 0 } },
        h("button", {
          ref: setPosBtnEl, type: "button", title: "切换停靠位置", "aria-label": "切换停靠位置", "aria-haspopup": "menu",
          "aria-expanded": menu?.kind === "position" ? "true" : "false",
          style: { ...btnBase, fontSize: 12 },
          onClick: () => { if (menu?.kind === "position") setMenu(null); else { setMenuPos(null); setMenu({ kind: "position", anchor: posBtnEl ?? menuBtnEl! }); } },
        }, "⇱"),
        menu?.kind === "position" ? menuNode : null,
      ) : null,
      h("span", { style: { position: "relative", display: "inline-flex", flexShrink: 0 } },
        h("button", { ref: setMenuBtnEl, type: "button", title: "区块操作", "aria-label": "区块操作", "aria-haspopup": "menu", "aria-expanded": menu?.kind === "main" ? "true" : "false",
          style: { ...btnBase, fontSize: 12, fontWeight: 700 },
          onClick: () => { if (menu?.kind === "main") { setMenu(null); } else { setMenuPos(null); setMenu({ kind: "main", anchor: menuBtnEl! }); } },
          onKeyDown: (e: any) => { if (e.key === "Escape" && menu?.kind === "main") setMenu(null); } }, "⋮"),
        menu?.kind === "main" ? menuNode : null,
      ),
    ),
    (!collapsed || keepAlive) && h("div", { style: { flex: collapsed ? "0 0 0" : 1, minHeight: 0, overflow: "hidden", display: collapsed ? "none" : "flex", flexDirection: "column" } }, children),
  );
}

/** ⋮ 菜单「上移/下移」请求广播（全栈键集只有 DockStack 容器知道——容器监听落位）。 */
export function requestBlockMove(blockKey: string, delta: number): void {
  try { window.dispatchEvent(new CustomEvent(SIDEBAR_MOVE_EVENT, { detail: { key: blockKey, delta } })); } catch { /* ignore */ }
}

/** 排序 v2：拖拽落点请求广播（dragged 移到 target 前/后；容器监听落位）。 */
export function requestBlockDrop(dragged: string, target: string, before: boolean): void {
  try { window.dispatchEvent(new CustomEvent(SIDEBAR_DROP_EVENT, { detail: { key: dragged, target, before } })); } catch { /* ignore */ }
}

/** 当前拖拽中的区块 key（同 bundle 实时读；跨 bundle 落位走 dataTransfer）。 */
let dragKey: string | null = null;

/* 拖放落点高亮样式（一次性注入；DOM API 加类，React 重渲染不冲） */
if (typeof document !== "undefined" && !document.getElementById("pi-dock-dnd-css")) {
  try {
    const st = document.createElement("style");
    st.id = "pi-dock-dnd-css";
    st.textContent = "[data-ext-dock-block][draggable=true] { cursor: grab; }"
      + ".pi-dock-drop-before { box-shadow: inset 0 2px 0 var(--accent, #2563eb); }"
      + ".pi-dock-drop-after { box-shadow: inset 0 -2px 0 var(--accent, #2563eb); }";
    document.head.appendChild(st);
  } catch { /* ignore */ }
}

/** 折叠态 hook（区块栈容器/外部同步用）：localStorage 单一事实源 + 变更事件订阅。 */
export function useBlockCollapsed(blockKey: string): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readBlockCollapsed(blockKey));
  useEffect(() => {
    const sync = () => setCollapsed(readBlockCollapsed(blockKey));
    sync();
    window.addEventListener(SIDEBAR_COLLAPSE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(SIDEBAR_COLLAPSE_EVENT, sync); window.removeEventListener("storage", sync); };
  }, [blockKey]);
  return [collapsed, (next: boolean) => writeBlockCollapsed(blockKey, next)];
}

/** 排序持久化 hook（DockStack 容器用）：readDockOrder + 变更事件订阅。 */
export function useDockOrder(): string[] {
  const [order, setOrder] = useState<string[]>(() => readDockOrder());
  useEffect(() => {
    const sync = () => setOrder(readDockOrder());
    sync();
    window.addEventListener(SIDEBAR_ORDER_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(SIDEBAR_ORDER_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return order;
}

/** 左栏停靠 gate（v4 泛化）：docked:sidebar:* 族（含旧 sidebar-explorer）任意落位即真。
 *  返回当前落位 zone（sidebar:<itemKey> | sidebar-explorer），未停靠返回 null。 */
export function useGateSidebar(itemKey: string): string | null {
  const state = usePresent(itemKey);
  if (!isSidebarDockState(state)) return null;
  return state === "docked:sidebar-explorer" ? "sidebar-explorer" : state.slice("docked:".length);
}

/** 左栏区块注册项（统一区块注册语义糖）：dockable 面板以 sidebar:* 为默认位时的
 *  sidebarExplorerDock 注册条目（meta 携 title/priority——DockStack 排序默认序消费）。
 *  face 门控 = useGateSidebar（sidebar 族任意落位渲染），头行走统一 DockBody。 */
export function sidebarBlockItem(opts: {
  key: string;                 // 完整 itemKey "extId:itemId"（= 注册复合 id 约定）
  title: string;
  priority?: number;           // 默认序（项目0→任务1→文件2→停靠3+）
  zones?: DockZone[];          // 位置全集（sidebar 族自动并入；右栏显式声明）
  defaultZone?: DockZone;
  renderContent: () => any;
}) {
  const zones: DockZone[] = opts.zones?.length ? opts.zones : [sidebarZoneOf(opts.key)];
  if (opts.defaultZone) seedDockDefault(opts.key, opts.defaultZone);
  else seedDockDefault(opts.key, zones.find((z) => z === "sidebar-explorer" || z.startsWith("sidebar:")) ?? zones[0]);
  declareDockZones(opts.key, zones, opts.defaultZone);
  const itemId = opts.key.includes(":") ? opts.key.slice(opts.key.indexOf(":") + 1) : opts.key;
  const SidebarFace = () => {
    const dockedZone = useGateSidebar(opts.key);
    if (!dockedZone) return null;
    return h(DockBody, {
      itemKey: opts.key, title: opts.title, chrome: "section" as const,
      zones, defaultZone: opts.defaultZone, kind: "dockable" as const,
    }, opts.renderContent());
  };
  return { id: itemId, render: SidebarFace, meta: { title: opts.title, priority: opts.priority } };
}

/* ── createDockFaces 工厂（v3 §2-F，G5 接入降本）：一个调用注册浮窗 + 各停靠面 ──
 *
 *   const faces = createDockFaces({ key: "my-ext:main", title: "我的面板",
 *     zones: ["right-panel"], defaultZone: "right-panel", renderContent: () => <MyContent/> });
 *   registerItems("dialogs", faces.dialogsItems);
 *   registerItems("rightFileDock", faces.rightFileDock);
 *   registerItems("sidebarExplorerDock", faces.sidebarExplorerDock);
 *
 * 打开入口仍由扩展调 openFloat(key)。浮窗壳 = 标准遮罩 + 面板（头行标题+✕ + 滚动体）；
 * 自带头行 UI 的内容可关 chrome（头行仍需自己调 closePanel(key)）。
 * 特例（git-review pages⇄dock 二面 / doc-center embedded）不走工厂，维持手写。 */
export function createDockFaces(opts: {
  key: string;                       // 完整 itemKey "extId:itemId"（= 注册 id 约定，防 dock tab 链断裂）
  title: string;
  zones: DockZone[];
  defaultZone?: DockZone;
  renderContent: () => any;          // 两面共用内容（ReactNode 工厂）
  /** 浮窗面板附加 data-ext-float-* 属性（w/h/full/min-w/pos…），如 { "data-ext-float-w": 760 } */
  floatAttrs?: Record<string, unknown>;
  /** 浮窗面板内联样式兑底（未装 float 时生效） */
  floatStyle?: Record<string, unknown>;
  /** 浮窗面宽度/高度（style 与 data-ext-float-w/-h 同步声明；缺省 760×560） */
  w?: number; hh?: number;
  /** 标准 chrome 头行（标题+✕）；内容自带头行时传 false（自己调 closePanel） */
  chrome?: boolean;
  /** dialogs item id（缺省 = key 第一个冒号后的 itemId 部分） */
  itemId?: string;
  /** 左栏区块默认序（meta.priority → DockStack 有效序；项目0→任务1→文件2→停靠3+） */
  priority?: number;
}) {
  const { key, title, zones, defaultZone, renderContent } = opts;
  const itemId = opts.itemId ?? (key.includes(":") ? key.slice(key.indexOf(":") + 1) : key);
  const w = opts.w ?? 760;
  const hh = opts.hh ?? 560;
  if (defaultZone) seedDockDefault(key, defaultZone); // 首次 open 直达默认位（§2-B）+ 注册表默认位
  declareDockZones(key, zones, defaultZone);     // TabBar ⇱ 菜单 zones 全集（v3.1）
  const dockAttrs: Record<string, unknown> = { "data-ext-float-dock": zones.join(" ") };
  if (defaultZone) dockAttrs["data-ext-float-dock-default"] = defaultZone;

  const FloatFace = () => {
    const gate = useGate(key, "float");
    if (!gate) return null;
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 311, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" },
      onClick: () => closePanel(key),
    },
      h("div", {
        "data-ext-float": "1",
        "data-ext-float-key": key,
        ...dockAttrs,
        ...(opts.floatAttrs ?? {}),
        style: {
          position: "fixed", width: `min(${w}px, 94vw)`, height: `min(${hh}px, 84vh)`,
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: "var(--bg-panel, #1a1a1a)", border: "1px solid var(--border, #444)",
          borderRadius: 12, boxShadow: "0 18px 60px rgba(0,0,0,0.4)", color: "var(--text, #ddd)",
          ...(opts.floatStyle ?? {}),
        },
        onClick: (e: any) => e.stopPropagation(),
      },
        opts.chrome !== false && h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px", flexShrink: 0 } },
          h("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600, flex: 1 } }, title),
          h("button", { type: "button", "aria-label": "关闭", title: "关闭", onClick: () => closePanel(key),
            style: { background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" } }, "✕"),
        ),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" } }, renderContent()),
      ),
    );
  };

  const makeDockFace = (zone: DockZone, chrome: "section" | "tab") => () => {
    // v4：左栏 face 门控放宽为 sidebar 族（docked:sidebar:* 任意区块位，兼容旧
    // sidebar-explorer——用户 dockpref 持久化旧值时照样渲染）；头行 zone 由状态推导。
    if (zone === "sidebar-explorer") {
      const dockedZone = useGateSidebar(key);
      if (!dockedZone) return null;
      return h(DockBody, { itemKey: key, zone, title, chrome, zones, defaultZone }, renderContent());
    }
    const docked = useGate(key, { dock: zone });
    if (!docked) return null;
    return h(DockBody, { itemKey: key, zone, title, chrome, zones, defaultZone }, renderContent());
  };

  const hasSidebarZone = zones.some((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
  return {
    dialogsItems: [{ id: itemId, render: FloatFace }],
    // ⚠ dock item 注册 raw itemId（宿主 registerItems 自动拼 extId:itemId = itemKey），
    // 与状态机 key 一致（demo/doc-center/git-review 同款约定；id: key 会拼出双前缀断链）
    rightFileDock: zones.includes("right-panel")
      ? [{ id: itemId, render: makeDockFace("right-panel", "tab"), meta: { title } }]
      : [],
    // v4：meta.priority 透传（DockStack 默认序：项目0→任务1→文件2→停靠3+；用户改序后失效）
    sidebarExplorerDock: hasSidebarZone
      ? [{ id: itemId, render: makeDockFace("sidebar-explorer", "section"), meta: { title, ...(opts.priority !== undefined ? { priority: opts.priority } : {}) } }]
      : [],
  };
}

/* flash 样式（一次性注入；docked 态重复 open 的容器高亮，2s 自删 class） */
if (typeof document !== "undefined" && !document.getElementById("piwe-dock-flash-css")) {
  try {
    const st = document.createElement("style");
    st.id = "piwe-dock-flash-css";
    st.textContent = "@keyframes piwe-dock-flash-kf { 0%,100% { box-shadow: none; } 30% { box-shadow: inset 0 0 0 2px var(--accent, #2563eb); } }"
      + ".piwe-dock-flash { animation: piwe-dock-flash-kf 2s ease; }";
    document.head.appendChild(st);
  } catch { /* ignore */ }
}

/* ── React 绑定（各扩展 bundle 自带 react；不引 react 的调用方直接用下面的 usePresent/useGate/DockBody） ── */


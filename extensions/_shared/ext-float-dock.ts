/**
 * _shared/ext-float-dock.ts — the extension-side **full surface** of the aiti-float dock
 * (heavy UI: DockBody, header toolbar hooks, faces factory). The state machine (present
 * store) has sunk into ./ext-float-dock-core.ts (zero react); shells use the thin layer
 * ./ext-float-dock-lite.ts (usePresent/useGate + the small state-machine API) — split
 * extensions' shells import lite without dragging in this file's UI layer
 * (P1-3, plan pi-web-eager-ext-split-plan.md §6).
 *
 * Historical import surface kept intact: re-exports core (state machine) + lite (hooks);
 * unpacked extensions keep importing the same way:
 * `import { usePresent, DockBody, ... } from "@aiti-ai/ext-shared/ext-float-dock"`.
 * Red line (dock plan §3.5): the gate is the only render switch — extensions must not
 * toggle the two faces (float/embedded) with their own state.
 */
import { useEffect, useState, createElement as h } from "react";
import { clampToViewport, fixedOrigin, zoomFactorOf } from "./popup-anchor";
// ── header/menu words: local bilingual table below (menuWord); core float/zone words live in ext-float-dock-core (dockWord) ──
const DOCK_MENU_WORDS: Record<string, { "zh-CN": string; en: string }> = {
  expand: { "zh-CN": "展开", en: "Expand" },
  collapse: { "zh-CN": "折叠", en: "Collapse" },
  block: { "zh-CN": "区块", en: "Block" },
  position: { "zh-CN": "切换停靠位置", en: "Change dock position" },
  actions: { "zh-CN": "区块操作", en: "Block actions" },
  dragReorder: { "zh-CN": "拖动排序", en: "Drag to reorder" },
  move: { "zh-CN": "移动", en: "Move" },
  pin: { "zh-CN": "钉住", en: "Pin" },
  unpin: { "zh-CN": "取消钉住", en: "Unpin" },
  moveUp: { "zh-CN": "上移", en: "Move up" },
  moveDown: { "zh-CN": "下移", en: "Move down" },
  tools: { "zh-CN": "工具", en: "Tools" },
  removeInstance: { "zh-CN": "移除本实例", en: "Remove this instance" },
  close: { "zh-CN": "关闭", en: "Close" },
  zones: { "zh-CN": "停靠方位", en: "Dock zones" },
  defaultSuffix: { "zh-CN": "（默认）", en: " (default)" },
};
function menuWord(key: keyof typeof DOCK_MENU_WORDS): string {
  let loc = "en";
  try { loc = window.localStorage.getItem("pi-locale") || "en"; } catch { /* storage unavailable */ }
  const w = DOCK_MENU_WORDS[key];
  return (w as any)[loc === "zh-CN" ? "zh-CN" : "en"] ?? w.en;
}
import { DOCK_ICON_NODES, DOCK_ICON_SVG_ROOT_PROPS, dockIconReactAttrs, type DockIconName } from "./dock-icons";

/** Icon element (React/h flavor; dock-icons is the single source): stroke=2 line art,
 *  currentColor. Same glyph and size as the DOM flavor createDockIconSvg (in core's
 *  appendDockIconRow). */
export function dockIconEl(name: DockIconName, size = 16): unknown {
  return h("svg", { width: size, height: size, ...DOCK_ICON_SVG_ROOT_PROPS, "aria-hidden": "true" },
    // kebab-case SVG attrs (stroke-width from thin()) must be camelized for React JSX
    ...DOCK_ICON_NODES[name].map((n, i) => h(n.tag, { key: i, ...dockIconReactAttrs(n.attrs) })));
}

/** CSS-mask span: icon asset URL tinted with currentColor (same rendering as the
 *  host's renderExtItemIcon). */
function maskedIconSpan(url: string, size: number): unknown {
  return h("span", { "aria-hidden": "true", style: {
    display: "inline-block", width: size, height: size, flexShrink: 0,
    background: "currentColor",
    WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")`,
    WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
    WebkitMaskPosition: "center", maskPosition: "center",
    WebkitMaskSize: "contain", maskSize: "contain",
  } });
}

/** Block-header icon declaration → React element (the DockBody icon prop contract).
 *  Five forms, aligned with the host's renderExtItemIcon (ExtUiItem.icon) contract so
 *  third-party extensions (npm-installed, not importing this module's name table) can
 *  fully self-host their icons, on both the static shell and the real face:
 *    1. React element (h()-built) → rendered as-is (fully self-held; the third-party main path);
 *    2. { svg: "<path …/>" } → inline SVG markup (24×24, stroke=currentColor; same shape
 *       as the host's {svg} form);
 *    3. { url: "https://…/icon.svg" } → CSS-mask span tinted with currentColor (expects a
 *       complete URL: the host-derived static-entry meta.iconUrl, or a value the extension
 *       resolved itself via its own ctx.apiUrl);
 *    4. a DOCK_ICON_NODES name-table hit → dockIconEl (built-in extensions' shortcut;
 *       also available to third parties via the @aiti-ai/ext-shared npm package);
 *    5. any other string → emoji/text glyph (host-identical fallback).
 *  A bare relative path "icons/x.svg" (the host manifest form) is NOT resolved here — it
 *  needs extId + the basePath-aware apiUrl and this module is ctx-free. On the static-shell
 *  path the host derives meta.iconUrl and the shell passes form ③; on the real-face path
 *  the owning extension resolves it itself (it has ctx.apiUrl). With an old host that lacks
 *  the derivation, the static shell simply renders no icon (graceful, no emoji-text fallback). */
export function dockIconFromDecl(icon: unknown, size = 13): unknown {
  if (icon == null) return null;
  if (typeof icon === "object") {
    const o = icon as Record<string, unknown>;
    if (typeof o.svg === "string") {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: o.svg } });
    }
    if (typeof o.url === "string") return maskedIconSpan(o.url, size);
    return null;
  }
  if (typeof icon !== "string" || !icon) return null;
  if (/^https?:\/\//.test(icon)) return maskedIconSpan(icon, size);
  if ((DOCK_ICON_NODES as Record<string, unknown>)[icon]) return dockIconEl(icon as DockIconName, size);
  if (icon.endsWith(".svg")) return null; // relative asset path: see doc above (host derives meta.iconUrl)
  return h("span", { style: { fontSize: size, lineHeight: 1 } }, icon); // emoji/text glyph
}

/* ── Sidebar block zone generalization (sidebar unified dock plan §3.8) ──
 * The pure state layer (present store + collapse/order/header store) lives in
 * ./ext-float-dock-core.ts (zero react — consumed by aiti-float's DockStack from the
 * same source); this file re-exports the full compat surface.
 * Canonical zone value = `sidebar:<itemKey>`; the legacy "sidebar-explorer" value stays
 * readable forever. */
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
  SIDEBAR_DISMISS_PREFIX, readBlockDismissed, writeBlockDismissed,
  readDockOrder, writeDockOrder,
  effectiveBlockOrder, moveBlockKey, migrateLegacyCollapseKeys,
  createDockHeaderStore, localDockHeaderStore, DOCK_HEADER_PENDING_TTL,
  // present state machine (P1-3: sunk from this file into core)
  present, presentState, onPresentChange, dockPref,
  openFloat, closePanel, dockTo, dockToSidebar, undockToFloat,
  setDockPref, clearDockPref, seedDockDefault, declareDockZones,
  positionMenuItems, positionMenuModel, declareDockWindowOpener, dockWindowOpenerOf, DOCK_ZONE_LABELS,
} from "./ext-float-dock-core";
// hooks thin layer (P1-3: sunk from this file into lite)
export { usePresent, useGate } from "./ext-float-dock-lite";
import {
  isSidebarDockState,
  readBlockCollapsed, writeBlockCollapsed,
  readDockOrder, localDockHeaderStore, FLOAT_INSTALLED_EVENT,
  SIDEBAR_COLLAPSE_EVENT, SIDEBAR_ORDER_EVENT, SIDEBAR_MOVE_EVENT, SIDEBAR_DROP_EVENT,
  floatApi, closePanel, positionMenuModel, seedDockDefault, declareDockZones, DOCK_ZONE_LABELS,
} from "./ext-float-dock-core";
import { usePresent, useGate } from "./ext-float-dock-lite";
import type { DockHeaderAction, DockHeaderCommands, DockHeaderState, DockHeaderStore, DockMenuItem, DockIconRowItem, MenuIconRowItem } from "./ext-float-dock-core";


/* ── Sidebar block stack: React bindings for collapse/order/migration live at the file
 *    tail (useBlockCollapsed/useDockOrder); the pure state layer is in
 *    ./ext-float-dock-core.ts. Only the position-menu item builder stays here (it leans
 *    on present action sugar). ── */

export function usePosition(itemKey: string, zones: DockZone[], defaultZone?: DockZone) {
  const state = usePresent(itemKey);
  return { state, zones, defaultZone, labels: DOCK_ZONE_LABELS };
}


/** Docked-face header (chrome="section", unified sidebar-block header v4): expand
 *  arrow + title + count + a **single ⋮ functional menu button** (collapse/position/
 *  move-up/move-down/remove/close shown or hidden by context — design review 6 ruled
 *  "no multi-button multi-position divergence"; the ⇱⇲✕ three buttons were folded into
 *  one menu). chrome="tab" (right TabBar) **renders no header** since v3.1 — the tab row
 *  already has ⇱ (position menu) + ✕; double-click = pull back to the float window. */
/* ── dock header toolbar: service/local store probing + hooks (v3; plan §2.3/§2.7) ── */

/** Current store: the aiti-float service (cross-bundle singleton) wins; fall back to the local store (same bundle) when absent. */
export function headerStore(): DockHeaderStore {
  const api = floatApi() as (FloatApi & { dockHeader?: DockHeaderStore }) | null;
  const svc = api?.dockHeader;
  return svc && typeof svc.register === "function" ? svc : localDockHeaderStore();
}

/** Request a dock-header command (face button → content implementation): hit runs immediately; miss expands the block + queues (TTL 10s). */
export function requestDockCommand(itemKey: string, actionId: string, payload?: unknown): boolean {
  return headerStore().request(itemKey, actionId, payload);
}

/** Store-online re-resolve tick (service install event): hooks/subscriptions add it to effect deps to rebind. */
export function useDockHeaderStoreTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((v) => v + 1);
    window.addEventListener(FLOAT_INSTALLED_EVENT, on);
    return () => window.removeEventListener(FLOAT_INSTALLED_EVENT, on);
  }, []);
  return tick;
}

/** Content registers command implementations (updates the reference every render; cleared on unmount). */
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

/** Content reports state (pure data such as active/done/root; notify only on signature change). */
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

/** Content registers extra ⋮ menu items (head/sep/item; complex file-operation menus etc.). */
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

/** Face reads the content-reported state (subscribes to re-render). */
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

/** DockBody internal: subscribes to this itemKey's actions/menuItems (signature change triggers re-render). */
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

/** Merge button sources: face props first + service/local store backfill (dedupe by id, keep declaration order). */
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

/** Menu render row (internal unified shape; head/sep/item). */
type DockMenuRow =
  | { type: "head"; label: string }
  | { type: "sep" }
  | { type: "item"; label: string; icon?: unknown; badge?: number | string; hint?: string; active?: boolean; alwaysRun?: boolean; disabled?: boolean; run: () => void }
  | { type: "icons"; label?: string; icon?: unknown; items: Array<DockIconRowItem | MenuIconRowItem> };

/** Docked-panel header (chrome="section", unified sidebar-block header v3): expand
 *  arrow + title slot + **declarative business buttons** (adaptive width; overflow
 *  auto-moves into the ⋮ "Tools" group) + **resident detach** (position menu) + a
 *  **single ⋮ functional menu** (tools overflow / content-registered menu items / block
 *  operations, three sections; long menus scroll).
 *  chrome="tab" (right TabBar) renders no header — the tab row already has ⇱ + ✕.
 *  Collapsed keep-alive: when content has registered commands (once mounted), collapsing
 *  keeps children (display:none) — header button state stays accurate and clicks are
 *  zero-latency; when unregistered, collapsing unmounts (preserves lazy loading). */
export function DockBody(props: {
  itemKey: string;
  zone?: DockZone;
  title?: string;
  /** Collapsed-header icon left of the title (chrome="section" only). Five forms
   *  (see dockIconFromDecl): React element / {svg} markup / {url} asset URL /
   *  dock-icons name string / emoji-text — third-party extensions carry their own
   *  icons without depending on the built-in name table. */
  icon?: unknown;
  /** Collapsed-header hover tooltip override. chrome="section" headers default to the
   *  functional hint (drag-handle text for dockable; none for reserved). Provide
   *  headerHint for a semantic description instead — typically on reserved blocks whose
   *  header would otherwise be mute. */
  headerHint?: string;
  /** "section": unified ⋮ header (sidebar blocks); "tab": no header (controls live on the host TabBar tab) */
  chrome?: "section" | "tab";
  /** Full set of dockable positions (detach position menu; default [zone] — single-zone panels need not pass it) */
  zones?: DockZone[];
  /** Extension-declared default position (the menu's trailing "default" mark; display only) */
  defaultZone?: DockZone;
  /** Block identity (collapse/order memory key; default = itemKey) */
  blockKey?: string;
  /** Externally controlled collapsed state (passed by the DockStack container) */
  collapsed?: boolean;
  onToggleCollapsed?: (next: boolean) => void;
  /** Count badge (e.g. subagent count) */
  count?: number;
  /** Resident block (reserved): no detach/close menu items; may carry onRemove (multi-instance "Remove this instance") */
  kind?: "dockable" | "reserved";
  /** Multi-instance block "Remove this instance" */
  onRemove?: () => void;
  /** "Close" action override (default closePanel(itemKey)) */
  onClose?: () => void;
  /** "Open in new window" capability (optional): when provided the position menu shows
   *  this item first (front of the icon row, glyph B); otherwise falls back to the
   *  registry (declareDockWindowOpener), and if still absent hides it (unsupported panel). */
  onNewWindow?: () => void;
  /** Extension extra menu items (pin and other multi-instance-only actions; inserted into the block-operations section) */
  extraMenuItems?: Array<{ label: string; icon?: unknown; hint?: string; active?: boolean; alwaysRun?: boolean; run: () => void }>;
  /** Move-row pin button (2026-11-24 menu single-row pass: pin merged into the front of
   *  the "Move" icon row) — rendered when provided (pin/pin-off icons switch with pinned
   *  state); when absent the move row only has move up/down. */
  moveRowPin?: { isPinned: () => boolean; toggle: () => void } | null;
  /** Hide the block section's "Close" item (set true when close has merged into the
   *  content ⋯ menu's "window" icon row, preventing a duplicate entry). */
  hideCloseItem?: boolean;
  /** Custom title slot (e.g. the folder block's directory switcher); replaces the title
   *  text when provided (title still feeds aria/fallback) */
  renderTitle?: () => unknown;
  /** Declarative header buttons (declared locally by the face; merged with
   *  service/local-store registered buttons, props win, dedupe by id) */
  headerActions?: DockHeaderAction[];
  children: any;
}) {
  const { itemKey, zone, title, chrome = "section", zones, defaultZone, children } = props;
  const kind = props.kind ?? "dockable";
  const blockKey = props.blockKey ?? itemKey;
  const selfCollapsed = useState<boolean>(() => readBlockCollapsed(blockKey));
  const collapsed = props.collapsed ?? selfCollapsed[0];
  // External collapse change (legacy key migration / cross-tab / container) → sync own state (don't follow when props control it)
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
    writeBlockCollapsed(blockKey, next); // single source of truth + broadcast (Stack syncs stack-cell flex)
    props.onToggleCollapsed?.(next);
  };
  // ── store data (content-registered actions/menuItems; re-render on signature change) ──
  const storeData = useDockHeaderStoreData(itemKey);
  // The ⋮ main menu / ⇱ position menu share one fixed popup (v3: menus can be long —
  // maxHeight+overflowY; inner scrolling is exempt from "any container scroll closes";
  // outside mousedown / outside scroll still close).
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
    if (m.height > below && above > below) top = b.top - gap - m.height; // flip upward
    const c = clampToViewport(b.right - m.width, top, m.width, m.height, pad);
    const o = fixedOrigin(menuEl);
    // Panel UI scale (CSS zoom on the sidebar / right-panel containers): b/m/o are all
    // viewport-space, but the menu's written inset is rendered scaled by the ancestor
    // zoom chain — divide back so the rendered position lands on the expected viewport
    // coordinates (zoom does not create a containing block; orthogonal to fixedOrigin).
    const z = zoomFactorOf(menuEl);
    const next = { left: (c.left - o.x) / z, top: (c.top - o.y) / z };
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
    // anchor position snapshot at open (displacement threshold for the scroll-close heuristic)
    let anchorTop: number | null = null;
    let anchorLeft: number | null = null;
    try { const a = menu.anchor?.getBoundingClientRect?.(); if (a) { anchorTop = a.top; anchorLeft = a.left; } } catch { /* ignore */ }
    const onScroll = (e: any) => {
      // Menu-inner scroll is exempt (long menus must scroll); scrolling outside closes
      // only when the anchor truly scrolled away (a fixed popup lingering at its old spot
      // = misplacement). Displacement threshold tolerance (2026-11-15 small-screen
      // feedback "the menu keeps closing itself"): during mobile URL-bar collapse /
      // rubber-banding / momentum fake scrolls the anchor hasn't moved (the fixed sidebar
      // overlay doesn't scroll with body) → don't close; close only past the threshold.
      if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
      try {
        const a = menu.anchor?.getBoundingClientRect?.();
        if (a && anchorTop !== null && anchorLeft !== null
          && Math.abs(a.top - anchorTop) < 4 && Math.abs(a.left - anchorLeft) < 4) return;
      } catch { /* ignore */ }
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, menuEl]);
  // ── Adaptive: header available width → visible business button count (ResizeObserver + window resize; no polling) ──
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [fitCount, setFitCount] = useState(4);
  useEffect(() => {
    if (!headerEl) return;
    const calc = () => {
      const w = headerEl.clientWidth || 0;
      if (w <= 0) return;
      // Fixed-occupation estimate: padding16 + arrow22 + title min56 + detach24 + ⋮24 + gaps12
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
  // .ts file (shared across extensions, jsx-runtime not guaranteed) → createElement instead of JSX syntax
  const btnBase: any = {
    background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer",
    fontSize: 11, lineHeight: 1, padding: "2px 5px", flexShrink: 0, fontFamily: "inherit",
  };
  // ── Business buttons: merge sources → collapse-filter visibility → adaptive truncation (rest go into the ⋮ "Tools" group) ──
  const allActions = mergeHeaderActions(props.headerActions, storeData.actions);
  const eligible = allActions.filter((a) => !collapsed || (a.visibility ?? "always") !== "expanded");
  const shownActions = eligible.slice(0, fitCount);
  const overflowActions = eligible.slice(fitCount);
  const actionBtn = (a: DockHeaderAction) => h("button", {
    key: a.id, type: "button", title: a.title, "aria-label": a.title, disabled: a.disabled === true,
    style: {
      ...btnBase, position: "relative" as const,
      color: a.done ? "var(--ok, #4ade80)" : a.active ? "var(--accent, #2563eb)" : "var(--text-muted, #888)",
      opacity: a.disabled ? 0.5 : 1, cursor: a.disabled ? "default" : "pointer",
    },
    onClick: (e: any) => { if (a.disabled !== true) a.onClick(e); },
  },
    a.icon ? h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center" } }, a.icon) : h("span", { style: { fontSize: 12, fontWeight: 700, lineHeight: 1 } }, "•"),
    (a.badge !== undefined && a.badge !== null && a.badge !== "") ? h("span", {
      style: { position: "absolute" as const, top: -5, right: -4, fontSize: 9, lineHeight: "13px", color: "var(--text-muted, #888)", background: "var(--bg-panel, #1a1a1a)", border: "1px solid var(--border, #444)", borderRadius: 7, padding: "0 3px" },
    }, String(a.badge)) : null);
  // ── ⋮ main menu (three sections: tools overflow / content-registered menu items / block operations) ──
  const buildMainMenu = (): DockMenuRow[] => {
    const out: DockMenuRow[] = [];
    // "Move" icon-row builder (optional pin button first): when menuItems carry a
    // moveRow slot, insert there (moved up); otherwise fall back to the block section's
    // default spot. When content is unmounted (collapse never expanded), menuItems are
    // absent and the block section's default move row also goes through this builder —
    // the pin button no longer appears only while mounted (2026-11-15).
    // Sorting is dockable-only: reserved blocks (fixed resident blocks like projects) get
    // no drag handle and no "move" row in the ⋮ menu.
    const sortable = kind !== "reserved";
    const buildMoveRow = (): DockMenuRow => ({
      type: "icons", label: menuWord("move"), icon: dockIconEl("move-diagonal-2", 13), items: [
        ...(props.moveRowPin ? [{
          key: "pin",
          icon: (props.moveRowPin.isPinned() ? "pin-off" : "pin") as any,
          label: props.moveRowPin.isPinned() ? menuWord("unpin") : menuWord("pin"),
          run: () => props.moveRowPin!.toggle(),
        }] : []),
        { key: "move-up", icon: "chevron-up", label: menuWord("moveUp"), run: () => requestBlockMove(blockKey, -1) },
        { key: "move-down", icon: "chevron-down", label: menuWord("moveDown"), run: () => requestBlockMove(blockKey, 1) },
      ],
    });
    if (overflowActions.length > 0) {
      out.push({ type: "head", label: menuWord("tools") });
      for (const a of overflowActions) out.push({ type: "item", label: a.title, icon: a.icon, badge: a.badge, active: a.active, alwaysRun: true, disabled: a.disabled, run: a.onClick });
    }
    if (storeData.menuItems && storeData.menuItems.length > 0) {
      if (out.length > 0) out.push({ type: "sep" });
      let moveRowInserted = false;
      for (const m of storeData.menuItems) {
        if (m.kind === "moveRow" && sortable && !moveRowInserted) { moveRowInserted = true; out.push(buildMoveRow()); continue; }
        if (m.kind === "head") out.push({ type: "head", label: m.label });
        else if (m.kind === "sep") out.push({ type: "sep" });
        else if (m.kind === "iconsRow") out.push({ type: "icons", label: m.label, items: m.items });
        else out.push({ type: "item", label: m.label, icon: m.icon, hint: m.hint, active: m.active, alwaysRun: m.alwaysRun, disabled: m.disabled, run: m.run });
      }
      if (chrome === "section" && sortable && !moveRowInserted) out.push(buildMoveRow());
    }
    const ops: DockMenuRow[] = [];
    if (chrome === "section" && sortable && !(storeData.menuItems || []).some((m) => m.kind === "moveRow")) {
      // Single-row "Move" (2026-09-15 user ruling, back to the §3.5 icon-row shape): a
      // leading diagonal double-arrow icon (move-diagonal-2, top-left + bottom-right) +
      // the row name rendered icon+text, echoing the block section's other rows;
      // chevron-up/down on the right move instantly. When menuItems carry a moveRow slot
      // the move row was already inserted earlier (not repeated here). Same source as the
      // mounted-state buildMoveRow: the pin button (when moveRowPin is provided) stays
      // visible/usable in the unmounted collapsed state too.
      ops.push(buildMoveRow());
    }
    if (kind === "reserved" && typeof props.onRemove === "function") {
      ops.push({ type: "item", label: menuWord("removeInstance"), icon: dockIconEl("trash", 13), run: () => props.onRemove!() });
    }
    if (Array.isArray(props.extraMenuItems)) {
      for (const m of props.extraMenuItems) ops.push({ type: "item", label: m.label, icon: m.icon, hint: m.hint, active: m.active, alwaysRun: m.alwaysRun, run: m.run });
    }
    if (kind === "dockable" && chrome === "section" && props.hideCloseItem !== true) {
      ops.push({ type: "item", label: menuWord("close"), icon: dockIconEl("x", 13), run: () => (props.onClose ? props.onClose() : closePanel(itemKey)) });
    }
    if (ops.length > 0) {
      if (out.length > 0) out.push({ type: "sep" });
      out.push({ type: "head", label: menuWord("block") });
      out.push(...ops);
    }
    return out;
  };
  const positionRows: DockMenuRow[] = menu?.kind === "position"
    // v5 icon row (plan §3.4): unified model (float → each dock position) + one row of
    // unambiguous zone icons
    ? [{ type: "icons" as const, label: menuWord("zones"), items: positionMenuModel(itemKey, allZones, defaultZone, state, { onNewWindow: props.onNewWindow }) }]
    : [];
  const menuRows: DockMenuRow[] = menu?.kind === "position" ? positionRows : (menu?.kind === "main" ? buildMainMenu() : []);
  const renderMenuRow = (it: DockMenuRow, i: number) => {
    if (it.type === "sep") return h("div", { key: `sep-${i}`, style: { height: 1, background: "var(--border, #444)", margin: "3px 4px", opacity: 0.7, flexShrink: 0 } });
    if (it.type === "head") return h("div", { key: `head-${i}`, style: { fontSize: 10, color: "var(--text-dim, #888)", fontWeight: 600, padding: "4px 10px 2px", letterSpacing: 0.3, userSelect: "none", whiteSpace: "nowrap" as const } }, it.label);
    // v5 icon row (plan §3.4/§3.5): one row of "name + right-aligned icon group"
    // (mirrors the menu style: name left, icons right-aligned; active state highlighted
    // and locked, default-position dot, hover tooltip); values match the DOM flavor.
    if (it.type === "icons") return h("div", {
      key: `icons-${i}`, role: "group", "data-ext-dock-icon-row": "1",
      style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "5px 10px", flexShrink: 0 },
    },
      it.label ? h("span", { key: "label", "data-ext-dock-icon-row-label": "1",
        // Leading row icon (optional): with an icon = an action row (body text color,
        // same style as the other icon+text rows); without = a pure caption name (dim,
        // e.g. the position menu's "Dock zones" title as-is).
        style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
          color: it.icon ? "var(--text, #ddd)" : "var(--text-dim, #888)", flexShrink: 0, userSelect: "none" as const, whiteSpace: "nowrap" as const } },
        it.icon ? h("span", { style: { display: "inline-flex", flexShrink: 0 } }, it.icon) : null,
        it.label) : null,
      h("div", { key: "group", "data-ext-dock-icon-group": "1",
        style: { display: "flex", gap: 6, marginLeft: "auto", flexShrink: 0 } },
        ...it.items.map((x, j) => {
          const isRadio = x.active === true || x.active === false;
          const tip = x.isDefault ? `${x.label}${menuWord("defaultSuffix")}` : x.label;
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
            typeof x.icon === "string" ? dockIconEl(x.icon as any, 16) : x.icon,
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
      // Long-menu scroll contract (v3): scrollable inside the viewport + scroll
      // containment (inner scroll does not trigger "container scroll closes")
      maxHeight: "min(70vh, calc(100vh - 16px))", overflowY: "auto" as const, overscrollBehavior: "contain" as const,
      // First frame off-screen (positioned after layout measurement, synced before paint, no flicker)
      ...(menuPos ? { left: menuPos.left, top: menuPos.top } : { left: -99999, top: -99999 }),
    },
    // Hover-close only on true hover devices (2026-11-15 small-screen feedback "the menu
    // keeps closing itself"): while a finger swipes through menu items on phones the
    // browser synthesizes mouse events (touchmove target change → synthetic mouseleave);
    // unconditional close equals "one swipe closes it". Touch (hover:none) ignores
    // mouseleave and closes via outside click/scroll instead.
    onMouseLeave: () => { try { if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return; } catch { /* no matchMedia → treat as desktop */ } setMenu(null); },
  }, menuRows.map(renderMenuRow)) : null;
  const toggleCollapsed = () => setCollapsed(!collapsed);
  // Order v2: the header is the HTML5 drag handle. The dragged key travels two channels:
  // dataTransfer (cross-bundle, readable in the drop phase) + module-level dragKey (read
  // live within the same bundle — dataTransfer is protected and unreadable during
  // dragover, used to suppress self-drag highlighting; self-drag is always same-bundle,
  // hence reliable). Drop before/after half decides the insertion point; the keyboard
  // path = ⋮ move up/down.
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
  if (chrome === "section" && kind !== "reserved") {
    // Drag handle only for dockable blocks (reserved = fixed-order resident blocks, e.g.
    // projects: no "drag to reorder" tooltip, not a drag handle; click-to-collapse unaffected).
    headerProps.draggable = true;
    headerProps.title = props.headerHint ?? menuWord("dragReorder");
    headerProps.onDragStart = onDragStart;
    headerProps.onDragOver = (e: any) => { if (isDockDrag(e) && dragKey !== blockKey) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dropMark(e, true); } };
    headerProps.onDragLeave = (e: any) => { try { if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return; } catch { /* ignore */ } dropMark(e, false); };
    headerProps.onDrop = onDrop;
    headerProps.onDragEnd = () => {
      dragKey = null;
      document.querySelectorAll(".pi-dock-drop-before, .pi-dock-drop-after").forEach((el) => el.classList.remove("pi-dock-drop-before", "pi-dock-drop-after"));
    };
  } else if (chrome === "section" && props.headerHint) {
    // Reserved header: mute by default; a semantic headerHint gives it a hover description.
    headerProps.title = props.headerHint;
  }
  // Collapsed-header icon (five-form declaration contract; see dockIconFromDecl)
  const iconNode = dockIconFromDecl(props.icon, 13);
  const titleNode = h("span", { style: { minWidth: 0, flex: "0 1 auto", display: "inline-flex", alignItems: "center", gap: 5 } },
    iconNode,
    props.renderTitle
      ? props.renderTitle()
      // 13px/500 body-color matches custom renderTitle headers (e.g. folder title
      // switcher) so every section header reads as the same tier; icon prop is 13 too.
      : h("span", { style: { fontSize: 13, fontWeight: 500, color: "var(--text, #222)", flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, minWidth: 0 } }, title ?? ""));
  // Collapsed keep-alive (v3): content has registered commands (once mounted) →
  // collapsing keeps children (hidden); button state and commands stay instantly usable
  const keepAlive = collapsed && storeData.hasCommands;
  return h("div", {
    "data-ext-float-dock-body": itemKey,
    "data-ext-item": itemKey,
    "data-ext-dock-block": blockKey,
    // Declaration attributes on the root: the TabBar ⇱ menu reads them directly when the
    // face is mounted (registry fallback takes precedence)
    "data-ext-float-dock": allZones.join(" "),
    ...(defaultZone ? { "data-ext-float-dock-default": defaultZone } : {}),
    // Registered button counts (for e2e/debug assertions): currently visible in header / overflow
    "data-ext-dock-actions": String(shownActions.length),
    "data-ext-dock-actions-overflow": String(overflowActions.length),
    style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", position: "relative" },
  },
    chrome === "section" && h("div", headerProps,
      h("button", {
        type: "button", title: collapsed ? menuWord("expand") : menuWord("collapse"), "aria-label": (title ?? menuWord("block")) + (collapsed ? " " + menuWord("expand") : " " + menuWord("collapse")),
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
          ref: setPosBtnEl, type: "button", title: menuWord("position"), "aria-label": menuWord("position"), "aria-haspopup": "menu",
          "aria-expanded": menu?.kind === "position" ? "true" : "false",
          style: { ...btnBase, fontSize: 12 },
          onClick: () => { if (menu?.kind === "position") setMenu(null); else { setMenuPos(null); setMenu({ kind: "position", anchor: posBtnEl ?? menuBtnEl! }); } },
        }, "⇱"),
        menu?.kind === "position" ? menuNode : null,
      ) : null,
      h("span", { style: { position: "relative", display: "inline-flex", flexShrink: 0 } },
        h("button", { ref: setMenuBtnEl, type: "button", title: menuWord("actions"), "aria-label": menuWord("actions"), "aria-haspopup": "menu", "aria-expanded": menu?.kind === "main" ? "true" : "false",
          style: { ...btnBase, fontSize: 12, fontWeight: 700 },
          onClick: () => { if (menu?.kind === "main") { setMenu(null); } else { setMenuPos(null); setMenu({ kind: "main", anchor: menuBtnEl! }); } },
          onKeyDown: (e: any) => { if (e.key === "Escape" && menu?.kind === "main") setMenu(null); } }, "⋮"),
        menu?.kind === "main" ? menuNode : null,
      ),
    ),
    (!collapsed || keepAlive) && h("div", { style: { flex: collapsed ? "0 0 0" : 1, minHeight: 0, overflow: "hidden", display: collapsed ? "none" : "flex", flexDirection: "column" } }, children),
  );
}

/** Broadcast a ⋮ menu "move up/down" request (only the DockStack container knows the
 *  full stack key set — the container listens and lands it). */
export function requestBlockMove(blockKey: string, delta: number): void {
  try { window.dispatchEvent(new CustomEvent(SIDEBAR_MOVE_EVENT, { detail: { key: blockKey, delta } })); } catch { /* ignore */ }
}

/** Order v2: broadcast a drag-drop request (move dragged before/after target; the
 *  container listens and lands it). */
export function requestBlockDrop(dragged: string, target: string, before: boolean): void {
  try { window.dispatchEvent(new CustomEvent(SIDEBAR_DROP_EVENT, { detail: { key: dragged, target, before } })); } catch { /* ignore */ }
}

/** The currently dragged block key (read live within the same bundle; cross-bundle
 *  landing goes through dataTransfer). */
let dragKey: string | null = null;

/* Drag-drop highlight styles (one-time injection; the DOM API adds classes, no clash with React re-renders) */
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

/** Collapsed-state hook (for the block-stack container / external sync): localStorage
 *  single source of truth + change-event subscription. */
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

/** Order persistence hook (for the DockStack container): readDockOrder + change-event subscription. */
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

/** Sidebar dock gate (v4 generalization): true for any landing in the docked:sidebar:*
 *  family (incl. legacy sidebar-explorer).
 *  Returns the current docked zone (sidebar:<itemKey> | sidebar-explorer); null when not
 *  docked. */
export function useGateSidebar(itemKey: string): string | null {
  const state = usePresent(itemKey);
  if (!isSidebarDockState(state)) return null;
  return state === "docked:sidebar-explorer" ? "sidebar-explorer" : state.slice("docked:".length);
}

/** Sidebar block registration entry (sugar over unified block registration): the
 *  sidebarExplorerDock entry for dockable panels whose default position is sidebar:*
 *  (meta carries title/priority — consumed by the DockStack default order).
 *  Face gate = useGateSidebar (renders on any sidebar-family landing); the header goes
 *  through the unified DockBody. */
export function sidebarBlockItem(opts: {
  key: string;                 // full itemKey "extId:itemId" (= the registration composite-id convention)
  title: string;
  /** Collapsed-header icon: five-form declaration (element / {svg} / {url} /
   *  dock-icons name / emoji-text; see dockIconFromDecl). */
  icon?: unknown;
  priority?: number;           // default order (projects0 → tasks1 → files2 → docks3+)
  zones?: DockZone[];          // full position set (sidebar family merged in automatically; right column declared explicitly)
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
      icon: opts.icon,
      zones, defaultZone: opts.defaultZone, kind: "dockable" as const,
    }, opts.renderContent());
  };
  return { id: itemId, render: SidebarFace, meta: { title: opts.title, priority: opts.priority } };
}

/* ── createDockFaces factory (v3 §2-F, cheaper G5 onboarding): one call registers the
 * float window + every docked face ──
 *
 *   const faces = createDockFaces({ key: "my-ext:main", title: "My panel",
 *     zones: ["right-panel"], defaultZone: "right-panel", renderContent: () => <MyContent/> });
 *   registerItems("dialogs", faces.dialogsItems);
 *   registerItems("rightFileDock", faces.rightFileDock);
 *   registerItems("sidebarExplorerDock", faces.sidebarExplorerDock);
 *
 * Opening stays with the extension calling openFloat(key). The float shell = standard
 * overlay + panel (header title + ✕ + scrolling body); content with its own header UI
 * can pass chrome=false (it still needs to call closePanel(key) itself).
 * Special cases (git-review pages⇄dock two faces / doc-center embedded) skip the
 * factory and stay hand-written. */
export function createDockFaces(opts: {
  key: string;                       // full itemKey "extId:itemId" (= registration id convention; prevents a broken dock-tab chain)
  title: string;
  /** Collapsed-header icon: five-form declaration (element / {svg} / {url} /
   *  dock-icons name / emoji-text; see dockIconFromDecl). */
  icon?: unknown;
  zones: DockZone[];
  defaultZone?: DockZone;
  renderContent: () => any;          // content shared by both faces (ReactNode factory)
  /** Extra data-ext-float-* attributes on the float panel (w/h/full/min-w/pos…), e.g. { "data-ext-float-w": 760 } */
  floatAttrs?: Record<string, unknown>;
  /** Inline-style fallback for the float panel (applies when float is not installed) */
  floatStyle?: Record<string, unknown>;
  /** Float face width/height (declared in sync via style and data-ext-float-w/-h; default 760×560) */
  w?: number; hh?: number;
  /** Standard chrome header (title + ✕); pass false when content carries its own header (it calls closePanel itself) */
  chrome?: boolean;
  /** dialogs item id (default = the itemId part after the first colon in key) */
  itemId?: string;
  /** Sidebar block default order (meta.priority → DockStack effective order; projects0 → tasks1 → files2 → docks3+) */
  priority?: number;
}) {
  const { key, title, zones, defaultZone, renderContent } = opts;
  const itemId = opts.itemId ?? (key.includes(":") ? key.slice(key.indexOf(":") + 1) : key);
  const w = opts.w ?? 760;
  const hh = opts.hh ?? 560;
  if (defaultZone) seedDockDefault(key, defaultZone); // first open lands directly on the default position (§2-B) + registry default
  declareDockZones(key, zones, defaultZone);     // the TabBar ⇱ menu's full zones set (v3.1)
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
          h("button", { type: "button", "aria-label": menuWord("close"), title: menuWord("close"), onClick: () => closePanel(key),
            style: { background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" } }, "✕"),
        ),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" } }, renderContent()),
      ),
    );
  };

  const makeDockFace = (zone: DockZone, chrome: "section" | "tab") => () => {
    // v4: the sidebar face gate widens to the sidebar family (any docked:sidebar:*
    // block position, still compatible with legacy sidebar-explorer — renders even when
    // the user's persisted dockpref holds the old value); the header zone derives from state.
    if (zone === "sidebar-explorer") {
      const dockedZone = useGateSidebar(key);
      if (!dockedZone) return null;
      return h(DockBody, { itemKey: key, zone, title, icon: opts.icon, chrome, zones, defaultZone }, renderContent());
    }
    const docked = useGate(key, { dock: zone });
    if (!docked) return null;
    return h(DockBody, { itemKey: key, zone, title, icon: opts.icon, chrome, zones, defaultZone }, renderContent());
  };

  const hasSidebarZone = zones.some((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
  return {
    dialogsItems: [{ id: itemId, render: FloatFace }],
    // ⚠ dock items register the raw itemId (the host registerItems auto-joins
    // extId:itemId = itemKey), consistent with the state-machine key (same convention as
    // demo/doc-center/git-review; id: key would double-prefix and break the chain)
    rightFileDock: zones.includes("right-panel")
      ? [{ id: itemId, render: makeDockFace("right-panel", "tab"), meta: { title } }]
      : [],
    // v4: pass meta.priority through (DockStack default order: projects0 → tasks1 →
    // files2 → docks3+; void once the user reorders)
    sidebarExplorerDock: hasSidebarZone
      ? [{ id: itemId, render: makeDockFace("sidebar-explorer", "section"), meta: { title, ...(opts.priority !== undefined ? { priority: opts.priority } : {}) } }]
      : [],
  };
}

/* Flash style (one-time injection; highlights the container on repeated open while docked, class self-removes after 2s) */
if (typeof document !== "undefined" && !document.getElementById("piwe-dock-flash-css")) {
  try {
    const st = document.createElement("style");
    st.id = "piwe-dock-flash-css";
    st.textContent = "@keyframes piwe-dock-flash-kf { 0%,100% { box-shadow: none; } 30% { box-shadow: inset 0 0 0 2px var(--accent, #2563eb); } }"
      + ".piwe-dock-flash { animation: piwe-dock-flash-kf 2s ease; }";
    document.head.appendChild(st);
  } catch { /* ignore */ }
}

/* ── React bindings (each extension bundle carries its own react; callers without react
 * use the usePresent/useGate/DockBody below directly) ── */


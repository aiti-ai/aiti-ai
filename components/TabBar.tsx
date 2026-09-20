"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";

/** Scroll step in px when the left/right scroll buttons are clicked. */
const SCROLL_STEP = 240;

/**
 * Computes the scrollLeft needed to bring the target tab into view; returns
 * null when already fully visible (never fights the user's manual scrolling).
 * Inputs are all viewport-coordinate rects (getBoundingClientRect) — only
 * difference math, no offsetParent dependency.
 */
export function computeTabRevealScrollLeft(metrics: {
  containerLeft: number;
  containerRight: number;
  scrollLeft: number;
  itemLeft: number;
  itemRight: number;
}): number | null {
  const { containerLeft, containerRight, scrollLeft, itemLeft, itemRight } = metrics;
  if (itemLeft < containerLeft) return Math.max(0, scrollLeft - (containerLeft - itemLeft));
  if (itemRight > containerRight) return scrollLeft + (itemRight - containerRight);
  return null;
}

/* ── File tab ⇱ position menu "dock placement" icon row (host side, 2026-09-17)────────────────
 * Matches the dock position menu (the floating-dock extension's shared icon row and dock icon
 * data): same shapes / same style / same order — new window → floating window → left panel →
 * right panel (labels collapse into tooltips).
 * No cross-repo dependency: the same lucide line-art paths are inlined here (kept in sync by
 * hand — when changing an icon, change both sides together). */
export type FilePosIconName = "new-window" | "float" | "panel-left" | "panel-right";

/** Placement icon (viewBox 24 / stroke 2 / round caps; same data as the host's dock icons). */
function DockPosIcon({ name }: { name: FilePosIconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === "new-window" ? (
        <>
          {/* square-arrow-out-up-right (open in new window) */}
          <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
          <path d="m21 3-9 9" />
          <path d="M15 3h6v6" />
        </>
      ) : name === "float" ? (
        <>
          {/* app-window (floating window; finalized by the user on 2026-09-15) */}
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M10 4v4" />
          <path d="M2 8h20" />
          <path d="M6 4v4" />
        </>
      ) : name === "panel-left" ? (
        <>
          {/* panel-left (left panel) */}
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
        </>
      ) : (
        <>
          {/* panel-right (right panel) */}
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M15 3v18" />
        </>
      )}
    </svg>
  );
}

/** File tab ⇱ position menu items (pure data model; shared by rendering and test assertions —
 *  the order contract is pinned here).
 *  Keys match the floating-dock extension's `data-ext-dock-icon` contract values (the sidebar
 *  family folds into sidebar-explorer). */
export interface FilePosMenuItem {
  key: "new-window" | "float" | "sidebar-explorer" | "right-panel";
  icon: FilePosIconName;
  label: string;
  run: () => void;
}

/** Builds the file tab position menu items in the same order as the dock position menu
 *  (new window → floating window → left panel → right panel); items whose capability callback
 *  is missing, and tabs without filePath, are automatically omitted (extension-absent
 *  degradation semantics unchanged). */
export function filePosMenuItems(
  tab: Tab,
  t: (key: string) => string,
  handlers: {
    onDetachTab?: (tab: Tab) => void;
    onOpenViewerWindow?: (tab: Tab) => void;
    onDockFileTab?: (tab: Tab, zone: "sidebar" | "right-panel") => void;
  },
): FilePosMenuItem[] {
  const items: FilePosMenuItem[] = [];
  if (handlers.onOpenViewerWindow) {
    const fn = handlers.onOpenViewerWindow;
    items.push({ key: "new-window", icon: "new-window", label: t("files.posNewWindow"), run: () => fn(tab) });
  }
  if (handlers.onDetachTab) {
    const fn = handlers.onDetachTab;
    items.push({ key: "float", icon: "float", label: t("files.posDetach"), run: () => fn(tab) });
  }
  if (handlers.onDockFileTab && tab.filePath) {
    const fn = handlers.onDockFileTab;
    items.push({ key: "sidebar-explorer", icon: "panel-left", label: t("files.posSidebar"), run: () => fn(tab, "sidebar") });
    items.push({ key: "right-panel", icon: "panel-right", label: t("files.posPanel"), run: () => fn(tab, "right-panel") });
  }
  return items;
}

/** Icon button (same spec as the floating-dock icon row: 28×28 / 6px radius / brighten on hover / tooltip=label). */
function PosIconButton({ item, onPick }: { item: FilePosMenuItem; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      title={item.label}
      aria-label={item.label}
      data-ext-dock-icon={item.key}
      style={{
        position: "relative", width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center",
        border: "none", borderRadius: 6, padding: 0, background: "none",
        color: "var(--text-muted)", cursor: "pointer", fontFamily: "inherit",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
      onClick={onPick}
    >
      <DockPosIcon name={item.icon} />
    </button>
  );
}

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  /** "file" (default) or "folder"/"terminal"/"dock" — folder tabs render a FolderViewer,
   *  terminal tabs render TerminalPanelBridge (T2 takeover: workspace terminals are hosted by
   *  the command extension),
   *  dock tabs render a docked extension panel (floating-dock extension v0.5.0: id "dock:<extId>:<itemId>") */
  kind?: "file" | "folder" | "terminal" | "dock";
  /** Pinned marker (maintained by the extension; core only passes it through — no eviction/close policy in core) */
  pinned?: boolean;
  /** Close/restart in progress (terminal tab: the raw "close"/"restart" value is passed through
   *  to the detached window's TerminalPanelBridge — the native fallback layer's restart semantics
   *  depend on it; rendering always normalizes to Boolean) */
  closing?: boolean | "close" | "restart";
  /** terminal tab (native fallback layer): restored-tab marker — passed through to detached
   *  windows; a restored tab must not silently start a shell */
  restored?: boolean;
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  viewerState?: FileViewerState;
  viewerRevision?: number;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Double-click/right-click a tab to detach it into a window (floating-dialog extension
   *  tab-detach v0.6.0/0.6.2; when omitted, double-click is a no-op and there is no context
   *  menu — zero impact on other consumers. Whether mobile passes it is up to the caller). */
  onDetachTab?: (tab: Tab) => void;
  /** File tab ⇱ "New window (standalone viewer)": ticket swap + viewer-extension handshake to
   *  open /viewer.
   *  When omitted, the ⇱ menu only contains "Floating window" (and if onDetachTab is also
   *  omitted, the whole ⇱ button does not render). */
  onOpenViewerWindow?: (tab: Tab) => void;
  /** File tab ⇱ "Left panel · block / Right panel · panel" (file dock face, 2026-09-16):
   *  explicit docking — converts the host tab into a dock face (file-editor extension dockFile:
   *  close the host tab + present dock:zone).
   *  When absent (extension missing) these two items do not render and the ⇱ menu falls back
   *  to floating window / new window. */
  onDockFileTab?: (tab: Tab, zone: "sidebar" | "right-panel") => void;
  /** Auto-reveal token: the host only increments it on user-initiated open/switch paths — the
   *  active tab is scrolled into view only when the token changes. History restore (bulk
   *  select:false silent background reopening of session tombstones) and its fallback activation
   *  do not increment it → they never steal the tab bar's current scroll position. Defaults to
   *  undefined, keeping the old behavior (scroll on any activeTabId / tabsKey change, for
   *  callers that do not use the token). */
  revealToken?: number;
}

/** Context menu items (tab-detach v0.6.2): file/folder/terminal → detach into a window;
 *  dock tab → detach into a floating window (present float, plan §5.8). "Move back to the right
 *  panel" is not in this menu — after detaching, the tab is no longer in the TabBar, and moving
 *  back goes through the window title bar ⇲ (the single semantic entry point). */
interface CtxMenu {
  tab: Tab;
  x: number;
  y: number;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onDetachTab, onOpenViewerWindow, onDockFileTab, revealToken }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  /** File tab ⇱ position menu (2026-09-16): a dock tab's ⇱ goes through the floating-dock
   *  extension; a file tab is not a dock face and has no swappable dock position — the menu
   *  only lists actually available forms: floating window (= the existing detach path)
   *  + new window (standalone /viewer). */
  const [posMenu, setPosMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);

  // Context menu closing: outside click / Escape / scroll (fixed-position menus don't follow scrolling; closing on scroll is safest)
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // File tab ⇱ position menu closing: same as the context menu (outside click / Escape / resize)
  useEffect(() => {
    if (!posMenu) return;
    const close = () => setPosMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPosMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [posMenu]);

  // Horizontal scrolling: when tabs overflow, show left/right scroll buttons at both ends.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollButtons = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollButtons();
    el.addEventListener("scroll", updateScrollButtons, { passive: true });
    const ro = new ResizeObserver(updateScrollButtons);
    ro.observe(el);
    window.addEventListener("resize", updateScrollButtons);
    return () => {
      el.removeEventListener("scroll", updateScrollButtons);
      ro.disconnect();
      window.removeEventListener("resize", updateScrollButtons);
    };
  }, [updateScrollButtons, tabs]);

  const scrollTabs = useCallback((dir: "left" | "right") => {
    scrollRef.current?.scrollBy({
      left: dir === "left" ? -SCROLL_STEP : SCROLL_STEP,
      behavior: "smooth",
    });
  }, []);

  // Scroll the active tab into view: auto-follow on new tab open (default-active) / switch /
  // restore; do nothing when already visible (never fights the user's manual scrolling). The
  // body only reads refs → stable reference, so the rAF correction can schedule itself directly.
  const activeTabIdRef = useRef(activeTabId);
  // When the container is invisible (mobile ≤640px panel display:none) it measures 0 width,
  // making measurement meaningless — skip and set a flag; the RO re-reveals once display
  // is restored.
  const needsRevealRef = useRef(false);
  const correctionFrameRef = useRef<number | null>(null);
  /** Writing scrollLeft toggles the left/right arrows' visibility, but the arrow placeholder
   *  only changes at the next React render; after a write, re-measure unconditionally for
   *  correctFrames consecutive frames — once layout settles, each frame is naturally a no-op
   *  (bounded frames, no infinite loop). User manual scrolling never enters this loop, so a
   *  scrolled-away position is never pulled back. */
  const revealActiveTab = useCallback((correctFrames = 0) => {
    const container = scrollRef.current;
    const targetId = activeTabIdRef.current;
    if (!container || !targetId) return;
    if (container.clientWidth <= 0) {
      needsRevealRef.current = true;
      return;
    }
    needsRevealRef.current = false;
    for (const child of Array.from(container.children)) {
      const el = child as HTMLElement;
      if (el.dataset.tabId !== targetId) continue;
      const containerRect = container.getBoundingClientRect();
      const itemRect = el.getBoundingClientRect();
      const next = computeTabRevealScrollLeft({
        containerLeft: containerRect.left,
        containerRight: containerRect.right,
        scrollLeft: container.scrollLeft,
        itemLeft: itemRect.left,
        itemRight: itemRect.right,
      });
      if (next !== null) container.scrollLeft = next;
      break;
    }
    // Scheduling is decoupled from whether a write happened: on frame 1 the arrows may not
    // have rendered yet (they look visible under the old layout); continuing frames only on
    // writes would terminate early — unconditional continuation lets the frame after the
    // layout update correct once more.
    if (correctFrames > 0 && correctionFrameRef.current == null) {
      correctionFrameRef.current = requestAnimationFrame(() => {
        correctionFrameRef.current = null;
        revealActiveTab(correctFrames - 1);
      });
    }
  }, []);
  useEffect(() => () => {
    if (correctionFrameRef.current != null) {
      cancelAnimationFrame(correctionFrameRef.current);
      correctionFrameRef.current = null;
    }
  }, []);

  // Use a stable signature instead of the tabs array reference: AppShell's panelTabs is built
  // inline and gets a new reference on every render, so depending on it directly would fire on
  // every parent render and yank the manually scrolled-away active tab back.
  const tabsKey = tabs.map((tab) => `${tab.id}\u0000${tab.label}`).join("\n");

  // Scroll trigger gating (revealToken): the host incrementing the token = user-initiated
  // open/switch → scroll; while the token is unchanged, activeTabId / tabsKey changes never
  // scroll — tabs appended by history restore (select:false silent background reopening) and
  // their fallback activation only update the active position, never stealing the user's
  // current scroll position (nor focus).
  // Defaults to undefined, keeping the old behavior (scroll on any activeTabId / tabsKey change).
  const prevRevealTokenRef = useRef(revealToken);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    if (revealToken !== undefined) {
      if (revealToken === prevRevealTokenRef.current) return;
      prevRevealTokenRef.current = revealToken;
    }
    revealActiveTab(4);
  }, [activeTabId, revealActiveTab, tabsKey, revealToken]);

  // The RO only covers one self-caused case: reveal skipped due to 0 width (mobile panel
  // display:none) → re-reveal once display is restored.
  // User manual scrolling / arrow visibility never set the flag, so scrolled-away positions
  // are never pulled back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (needsRevealRef.current) revealActiveTab(2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [revealActiveTab]);

  // Mouse wheel: convert vertical scrolling to horizontal (take over only when tabs overflow;
  // let the page scroll otherwise).
  // React onWheel cannot be used — it registers as passive on the root, so preventDefault has no effect.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      if (e.deltaMode === 1) delta *= 16; // lines → px (Firefox default)
      else if (e.deltaMode === 2) delta *= el.clientWidth; // pages → px
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const arrowButtonStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
    width: 20, height: "100%",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  };

  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        alignItems: "center",
        background: "var(--bg-panel)",
        flexShrink: 0,
        height: 36,
      }}
    >
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scrollTabs("left")}
          title={t("files.scrollLeft")}
          aria-label={t("files.scrollLeft")}
          style={arrowButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}
      <div
        ref={scrollRef}
        className="tabbar-scroll"
        style={{
          display: "flex",
          alignItems: "flex-end",
          overflowX: "auto",
          overflowY: "hidden",
          flex: 1,
          height: 36,
          /* Scrollbar styling lives in globals.css .tabbar-scroll (ultra-thin, light); do not
             set scrollbarWidth here — on Chrome 121+ setting scrollbar-width disables the
             ::-webkit-scrollbar customization and reverts to the native thick scrollbar */
        }}
      >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            role="tab"
            aria-label={tab.kind === "terminal" ? t("terminal.tabLabel", { name: tab.label }) : tab.label}
            aria-selected={isActive}
            tabIndex={isActive || (!activeTabId && tabs[0].id === tab.id) ? 0 : -1}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab.id);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                onSelectTab(tabs[next].id);
                (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
              }
            }}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={onDetachTab ? () => onDetachTab(tab) : undefined}
            onContextMenu={onDetachTab ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ tab, x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 70) });
            } : undefined}
            title={onDetachTab ? t("files.detachHint") : undefined}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              if (!tab.closing) onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "folder" ? <FolderIcon size={13} open={isActive} /> : tab.kind === "terminal" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              ) : tab.kind === "dock" ? (
                // Docked tab (floating-dock extension v0.5.0): four-cell grid glyph, distinct from the file/terminal glyphs
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" />
                  <rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" />
                </svg>
              ) : getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            {tab.kind === "dock" && (
              /* v3.1 position picker: dock tab ⇱ → piwe-float-dock-menu event (menu rendered by
                 the floating-dock extension / fallback layer: floating window / left panel /
                 right panel + current-position checkmark + default marker). The unified
                 reposition entry point for the docked state — the content area no longer
                 renders the DockBody header row (eliminating three stacked toolbars). */
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  try {
                    const r = e.currentTarget.getBoundingClientRect();
                    window.dispatchEvent(new CustomEvent("piwe-float-dock-menu", {
                      detail: { key: tab.id.slice(5), rect: { left: r.left, bottom: r.bottom } },
                    }));
                  } catch { /* ignore */ }
                }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20,
                  background: "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: isActive ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 11,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                title={t("tabbar.posDock")}
                aria-label={`${t("files.posTitle")} ${tab.label}`}
              >
                ⇱
              </button>
            )}
            {(tab.kind ?? "file") === "file" && (onDetachTab || onOpenViewerWindow || onDockFileTab) && (
              /* File tab ⇱ (2026-09-16): not a dock face; the menu is rendered by the host
                 itself — floating window (detach) / new window (/viewer) / left-panel block,
                 right-panel panel (dock-face conversion); same anchor and appearance as the
                 dock tab's ⇱ for consistent interaction expectations. ⚠ A missing kind means
                 file (openFileTab doesn't set kind), so the comparison must be normalized —
                 a strict === "file" would keep the plain file tab's ⇱ from ever rendering
                 (pitfall confirmed in §7 testing). */
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setPosMenu({ tab, x: Math.min(r.left, window.innerWidth - 180), y: r.bottom + 4 });
                }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20,
                  background: "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: isActive ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 11,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                title={t("files.posTitle")}
                aria-label={`${t("files.posTitle")} ${tab.label}`}
              >
                ⇱
              </button>
            )}
            <button
              disabled={Boolean(tab.closing)}
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
               title={t(tab.kind === "terminal" ? "terminal.close" : "i18n.close")}
               aria-label={`${t(tab.kind === "terminal" ? "terminal.close" : "i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
      </div>
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scrollTabs("right")}
          title={t("files.scrollRight")}
          aria-label={t("files.scrollRight")}
          style={arrowButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}
      {/* File tab ⇱ position menu (rendered by the host; a dock tab's ⇱ goes through the
          floating-dock extension and never reaches here).
          Same style and order as the dock position menu (the floating-dock "placement" icon
          row): new window → floating window → left panel → right panel; labels collapse into
          tooltips (cross-repo icon data synced by hand, see filePosMenuItems above).
          Portal mounts on body: in right-panel overlay mode the container has a transform,
          so an in-place fixed element would be offset by its containing block. */}
      {posMenu && createPortal(
        <div
          role="menu"
          style={{
            position: "fixed",
            left: posMenu.x,
            top: posMenu.y,
            zIndex: 3200,
            minWidth: 190,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.28)",
            padding: 4,
            fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            data-ext-dock-icon-row="1"
            role="group"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "5px 10px" }}
          >
            <span
              data-ext-dock-icon-row-label="1"
              style={{ fontSize: 12, color: "var(--text-dim)", flexShrink: 0, userSelect: "none", whiteSpace: "nowrap" }}
            >
              {t("files.posDockRow")}
            </span>
            <div data-ext-dock-icon-group="1" style={{ display: "flex", gap: 6, marginLeft: "auto", flexShrink: 0 }}>
              {filePosMenuItems(posMenu.tab, t, { onDetachTab, onOpenViewerWindow, onDockFileTab }).map((item) => (
                <PosIconButton
                  key={item.key}
                  item={item}
                  onPick={() => { setPosMenu(null); item.run(); }}
                />
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* Context menu (tab-detach v0.6.2): fixed positioning (portal mounts on body — the
          right-panel overlay container has a transform, so an in-place fixed element would be
          offset by its containing block); closes on outside click / Escape (effect attaches
          window-level listeners) */}
      {ctxMenu && onDetachTab && createPortal(
        <div
          role="menu"
          style={{
            position: "fixed",
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 3200,
            minWidth: 150,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.28)",
            padding: 4,
            fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "7px 10px", border: "none", borderRadius: 6, cursor: "pointer",
              background: "transparent", color: "var(--text)", textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            onClick={() => { const tab = ctxMenu.tab; setCtxMenu(null); onDetachTab(tab); }}
          >
            {ctxMenu.tab.kind === "dock" ? t("files.ctxFloat") : t("files.ctxDetach")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

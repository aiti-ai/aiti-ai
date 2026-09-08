"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";

/** 点击左右滚动按钮时的滚动步长（px）。 */
const SCROLL_STEP = 240;

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  /** "file" (default) or "folder"/"terminal"/"dock" — folder tabs render a FolderViewer，
   *  terminal tabs 渲染 TerminalPanelBridge（[aiti] T2 接管：工作区终端由 aiti-cmd 承载），
   *  dock tabs 渲染停靠的扩展面板（aiti-float dock v0.5.0：id "dock:<extId>:<itemId>"） */
  kind?: "file" | "folder" | "terminal" | "dock";
  /** 钉住标记（由扩展维护，core 只透传——不在 core 做逐出/关闭策略） */
  pinned?: boolean;
  closing?: boolean;
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
  /** 双击/右键 tab 拆出为窗口（aiti-float tab-detach v0.6.0/0.6.2；不传则双击无操作、
   *  无右键菜单——其他使用方零影响。mobile 由调用方决定是否传入）。 */
  onDetachTab?: (tab: Tab) => void;
}

/** 右键菜单项（tab-detach v0.6.2）：file/folder/terminal → 拆出为窗口；dock tab → 拆出为
 *  浮窗（present float，方案 §5.8）。「移回右栏」不在本菜单——拆出后 tab 不在 TabBar，
 *  移回经窗口标题栏 ⇲（语义唯一入口）。 */
interface CtxMenu {
  tab: Tab;
  x: number;
  y: number;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onDetachTab }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  // 右键菜单关闭：点外/ Escape/滚动（fixed 定位菜单不跟随滚动，收掉最稳）
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

  // 横向滚动：tabs 溢出时两端显示左右滚动按钮。
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

  // 鼠标滚轮：垂直滚动转横向滚动（仅页签溢出时接管，不溢出时放行页面滚动）。
  // 不能用 React onWheel——它在 root 上注册为 passive，preventDefault 无效。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      if (e.deltaMode === 1) delta *= 16; // 行 → px（Firefox 默认）
      else if (e.deltaMode === 2) delta *= el.clientWidth; // 页 → px
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
          /* 滚动条样式走 globals.css .tabbar-scroll（超细浅色）；勿在此设 scrollbarWidth——
             Chrome 121+ 设了 scrollbar-width 会禁用 ::-webkit-scrollbar 定制退回原生粗滚动条 */
        }}
      >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
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
                // 停靠 tab（aiti-float dock v0.5.0）：四格板块图形，与文件/终端图形区分
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
            <button
              disabled={tab.closing}
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
               title={t("i18n.close")}
               aria-label={`${t("i18n.close")} ${tab.label}`}
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
      {/* 右键菜单（tab-detach v0.6.2）：fixed 定位；点外/Escape 关闭（effect 挂窗级监听） */}
      {ctxMenu && onDetachTab && (
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
        </div>
      )}
    </div>
  );
}

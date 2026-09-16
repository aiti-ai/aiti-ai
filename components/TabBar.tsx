"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";

/** 点击左右滚动按钮时的滚动步长（px）。 */
const SCROLL_STEP = 240;

/**
 * 计算把目标 tab 滚进视野所需的 scrollLeft；已完全可见时返回 null（不打扰用户手动滚动）。
 * 入参均为视口坐标的 rect（getBoundingClientRect）——只做差值换算，不依赖 offsetParent。
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

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  /** "file" (default) or "folder"/"terminal"/"dock"/"image" — folder tabs render a FolderViewer，
   *  terminal tabs 渲染 TerminalPanelBridge（[aiti] T2 接管：工作区终端由 aiti-cmd 承载），
   *  dock tabs 渲染停靠的扩展面板（aiti-float dock v0.5.0：id "dock:<extId>:<itemId>"），
   *  image tabs 渲染 ImageTabViewer（消息图片预览多开：src 非磁盘路径，无 FileViewer/watch） */
  kind?: "file" | "folder" | "terminal" | "dock" | "image";
  /** image tab 的图片 src（data URL / 会话图片 API URL 等；kind:"image" 专用） */
  imageSrc?: string;
  /** 钉住标记（由扩展维护，core 只透传——不在 core 做逐出/关闭策略） */
  pinned?: boolean;
  /** 关闭/重启收尾中（terminal tab："close"/"restart" 原值供拆出窗口透传
   *  TerminalPanelBridge——原生兜底层的重启语义依赖它；渲染处一律 Boolean 归一） */
  closing?: boolean | "close" | "restart";
  /** terminal tab（原生兜底层）：恢复页签标记——拆出窗口透传，恢复页签不静默起 shell */
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
  /** 双击/右键 tab 拆出为窗口（aiti-float tab-detach v0.6.0/0.6.2；不传则双击无操作、
   *  无右键菜单——其他使用方零影响。mobile 由调用方决定是否传入）。 */
  onDetachTab?: (tab: Tab) => void;
  /** 文件 tab ⇱「新窗口（独立查看器）」：换票 + aiti-viewer 握手打开 /viewer。
   *  缺省不传则 ⇱ 菜单只含「浮窗」一项（onDetachTab 也不传则整个 ⇱ 不渲染）。 */
  onOpenViewerWindow?: (tab: Tab) => void;
  /** 自动滚入视野令牌：宿主仅在「用户自主打开/切换」路径递增——令牌变化才把激活 tab
   *  滚进视野。历史恢复（session 墓碑批量 select:false 后台静默打开）与其兜底激活不递
   *  增 → 不抢页签条当前滚动位置。缺省 undefined 保持旧行为（activeTabId / tabsKey
   *  变化即滚，供不使用令牌的调用方沿用）。 */
  revealToken?: number;
}

/** 右键菜单项（tab-detach v0.6.2）：file/folder/terminal → 拆出为窗口；dock tab → 拆出为
 *  浮窗（present float，方案 §5.8）。「移回右栏」不在本菜单——拆出后 tab 不在 TabBar，
 *  移回经窗口标题栏 ⇲（语义唯一入口）。 */
interface CtxMenu {
  tab: Tab;
  x: number;
  y: number;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onDetachTab, onOpenViewerWindow, revealToken }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  /** 文件 tab ⇱ 位置菜单（2026-09-16）：dock tab 的 ⇱ 走 aiti-float；文件 tab 不是
   *  dock face，没有可换的停靠位——菜单只列实际可用的形态：浮窗（=既有 detach 链路）
   *  + 新窗口（独立查看器 /viewer）。 */
  const [posMenu, setPosMenu] = useState<{ tab: Tab; x: number; y: number } | null>(null);

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

  // 文件 tab ⇱ 位置菜单关闭：同右键菜单（点外/Escape/resize）
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

  // 激活 tab 滚进视野：打开新 tab（默认激活）/切换/恢复时自动跟随；已可见不动
  // （避免抢用户手动滚动）。函数体只读 ref → 引用稳定，rAF 校正可直接回调自身。
  const activeTabIdRef = useRef(activeTabId);
  // 容器不可见（移动端 ≤640px 面板 display:none）时为 0 宽，测量无意义，跳过并留
  // 标记——RO 在显示恢复后补滚。
  const needsRevealRef = useRef(false);
  const correctionFrameRef = useRef<number | null>(null);
  /** 写入 scrollLeft 会触发左右箭头显隐，而箭头占位要到下一次 React 渲染才变；
   *  写入后连续 correctFrames 帧无条件重测，布局稳定后每帧自然 no-op（有限帧，不会
   *  死循环）。用户手动滚动不进入本循环，故滚开的位置不会被拉回。 */
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
    // 调度与是否写入解耦：帧 1 时箭头可能还没渲染（旧布局下看似可见），
    // 若只在写入时续帧会提前终止；无条件续帧让布局更新后的那一帧能再校一次。
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

  // 用稳定签名而非 tabs 数组引用：AppShell 的 panelTabs 是行内新建数组、每次渲染都换引用，
  // 直接依赖会按「每次父渲染」触发，把手动滚开的激活 tab 拽回来。
  const tabsKey = tabs.map((tab) => `${tab.id}\u0000${tab.label}`).join("\n");

  // 滚动触发门控（revealToken）：宿主递增令牌 = 用户自主打开/切换 → 滚；令牌未变时
  // activeTabId / tabsKey 变化一律不滚——历史恢复（select:false 后台静默打开）追加的
  // 页签与它的兜底激活只更新激活位，不抢用户当前的滚动位置（也不切焦点）。
  // 缺省 undefined 保持旧行为（activeTabId / tabsKey 变化即滚）。
  const prevRevealTokenRef = useRef(revealToken);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    if (revealToken !== undefined) {
      if (revealToken === prevRevealTokenRef.current) return;
      prevRevealTokenRef.current = revealToken;
    }
    revealActiveTab(4);
  }, [activeTabId, revealActiveTab, tabsKey, revealToken]);

  // RO 只兜一种自因场景：reveal 因 0 宽被跳过（移动端面板 display:none）→ 显示恢复后补滚。
  // 用户手动滚动 / 箭头显隐不置任何标记，故不会把滚开的位置拉回。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (needsRevealRef.current) revealActiveTab(2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [revealActiveTab]);

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
                // 停靠 tab（aiti-float dock v0.5.0）：四格板块图形，与文件/终端图形区分
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" />
                  <rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" />
                </svg>
              ) : tab.kind === "image" ? (
                // 图片预览 tab：山与太阳图形（lucide image）
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
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
              /* v3.1 位置选择器：dock tab ⇱ → piwe-float-dock-menu 事件（菜单由 aiti-float/
                 降级层渲染：浮窗/左栏/右栏 + 当前态✓ + 默认标）。停靠态的统一换位入口——
                 内容区不再渲染 DockBody 头行（消灭三层工具条）。 */
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
                title="位置（浮窗/左栏/右栏）"
                aria-label={`Position ${tab.label}`}
              >
                ⇱
              </button>
            )}
            {tab.kind === "file" && (onDetachTab || onOpenViewerWindow) && (
              /* 文件 tab ⇱（2026-09-16）：非 dock face，菜单由宿主自渲染——浮窗（detach）/
                 新窗口（/viewer）；与 dock tab 的 ⇱ 同锚位同外观，交互预期一致。 */
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
      {/* 文件 tab ⇱ 位置菜单（宿主自渲染；dock tab 的 ⇱ 走 aiti-float 不进这里） */}
      {posMenu && (
        <div
          role="menu"
          style={{
            position: "fixed",
            left: posMenu.x,
            top: posMenu.y,
            zIndex: 3200,
            minWidth: 170,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.28)",
            padding: 4,
            fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {onDetachTab && (
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
              onClick={() => { const tab = posMenu.tab; setPosMenu(null); onDetachTab(tab); }}
            >
              {t("files.posDetach")}
            </button>
          )}
          {onOpenViewerWindow && (
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
              onClick={() => { const tab = posMenu.tab; setPosMenu(null); onOpenViewerWindow(tab); }}
            >
              {t("files.posNewWindow")}
            </button>
          )}
        </div>
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

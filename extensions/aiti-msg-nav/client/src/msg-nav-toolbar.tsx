/**
 * msg-nav-toolbar —— 消息滚动导航条（JSX 版）。
 *
 * 端口自 pi-web 原内置 components/ScrollToolbar.tsx（到最早 / 到最新 / 上一个用户
 * 输入 / 下一个用户输入 + 长按保持屏幕常亮 + 拖拽换位）。核心改动：不再从 ChatWindow
 * props 拿 messageRefs/visibleMessages/setVisibleCount，改由 DOM 契约发现：
 *   - [data-chat-scroll]            消息滚动容器（到最早/到最新的目标）
 *   - [data-chat-msg-role="user"]  用户消息（上一/下一个用户输入的导航目标）
 * 懒分页由 core 的 sentinel IntersectionObserver 驱动：滚到容器顶端即自动加载更早
 * 消息并保持视口，扩展延时重试即可，无需 setVisibleCount。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getFeatures, onFeatureChange, t } from "./host-shim";

const SCROLL_ANCHOR_THRESHOLD = 80;
const CHAT_MINIMAP_WIDTH = 4;
const TOOLBAR_W = 44;
const TOOLBAR_MIN_H = 206;

/** 容器内消息包装节点（data-chat-msg-role 由 core 标记在每条可见消息外层）。 */
function getMsgEls(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-chat-msg-role]"));
}
function getUserEls(container: Element): HTMLElement[] {
  return getMsgEls(container).filter((el) => el.getAttribute("data-chat-msg-role") === "user");
}
/** 元素在容器坐标系里的 top（滚动后仍正确）。 */
function elTopInContainer(el: HTMLElement | null, c: Element): number {
  if (!el || !el.isConnected) return -1;
  return el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
}

/**
 * Screen Wake Lock（端口自 core hooks/useWakeLock.ts）。@returns true=API 可用。
 */
function useWakeLock(active: boolean): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined" && "wakeLock" in navigator) setSupported(true);
  }, []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let disposed = false;
    const acquire = async () => {
      if (disposed || !activeRef.current || sentinelRef.current) return;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (disposed || !activeRef.current) {
          sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
          if (activeRef.current && !disposed && document.visibilityState === "visible") acquire();
        });
      } catch {
        /* NotAllowedError —— visibilitychange 时重试 */
      }
    };
    acquire();
    const onVisibility = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s) s.release().catch(() => {});
    };
  }, [active]);
  return supported;
}

interface Pos { align: "left" | "right"; y: number }
const DEFAULT_POS: Pos = { align: "right", y: 12 };

function ArrowUp() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}
function ArrowDown() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function PrevUserIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={12} cy={5} r={1.6} />
      <path d="M12 8v6" />
      <path d="M8 13h8" />
    </svg>
  );
}
function NextUserIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={12} cy={19} r={1.6} />
      <path d="M12 16v-6" />
      <path d="M8 11h8" />
    </svg>
  );
}

const btnBase: React.CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: TOOLBAR_W,
  height: TOOLBAR_W,
  borderRadius: "50%",
  border: "1px solid var(--border)",
  background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
  color: "var(--text-muted)",
  cursor: "pointer",
  boxShadow: "0 2px 8px rgba(15,23,42,0.18)",
  transition: "color 0.12s, background 0.12s",
};

type TooltipKind = "earliest" | "prevUser" | "nextUser" | "latest";

const tooltipTop: Record<TooltipKind, number> = {
  earliest: 17,
  prevUser: 71,
  nextUser: 125,
  latest: 179,
};

export function ScrollNavToolbar(props: {
  agentRunning?: boolean;
  isMobile?: boolean;
  /** core 全量展开历史（ChatMinimap onRevealHistory 同源：一次性 setVisibleCount(messages.length*2)）。
   * 「到最早/上一条」跳转目标在渲染窗口外时用它，不再依赖 sentinel 逐页。 */
  revealHistory?: () => void;
  /** 活跃会话 id：会话切换时清两个跟随窗口（容器 div 常被 React 复用，身份不变，
   * RO/MO 通道不会触发，必须靠 prop 变化兜底）。 */
  sessionId?: string;
}) {
  const agentRunning = props.agentRunning === true;
  const isMobile = typeof props.isMobile === "boolean" ? props.isMobile : (typeof window !== "undefined" && window.innerWidth < 768);
  // 存 ref：跳转路径都在事件回调里，读最新闭包即可
  const revealHistoryRef = useRef<(() => void) | null>(null);
  revealHistoryRef.current = props.revealHistory ?? null;

  // feature 变更（extman 启停）→ 强制重渲染刷新开关状态
  const [, force] = useState(0);
  useEffect(() => onFeatureChange(() => force((v) => v + 1)), []);
  const features = getFeatures();
  const showToolbar = features["show.toolbar"] !== false;
  const keepAwakeFeature = features["behavior.keepAwake"] !== false;

  // —— 拖拽位置（viewport 相对；localStorage 持久化，与旧内置版同 key 保留用户习惯）——
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const raw = localStorage.getItem("pi-scroll-toolbar-pos");
      if (raw) {
        const parsed = JSON.parse(raw) as { align?: "left" | "right"; y?: number };
        if (typeof parsed.y === "number" && (parsed.align === "left" || parsed.align === "right")) {
          return { align: parsed.align, y: parsed.y };
        }
      }
    } catch { /* ignore */ }
    return DEFAULT_POS;
  });
  const posRef = useRef(pos);
  const setPosAndRef = useCallback((p: Pos) => { posRef.current = p; setPos(p); }, []);
  const dragRef = useRef<{ startX: number; startY: number; startY0: number; moved: boolean; pointerId: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const dragModeRef = useRef(false);
  const tapNavigatedRef = useRef(false);
  const lastNavTargetRef = useRef<HTMLElement | null>(null);

  // —— 滚动锚点跟踪：按钮只在「有可滚处」且「滚动中/悬停」时出现 ——
  const [scrollAnchors, setScrollAnchors] = useState({ atTop: true, atBottom: true });
  const [scrollActive, setScrollActive] = useState(false);
  const [scrollBtnsHovered, setScrollBtnsHovered] = useState(false);
  const [scrollTooltip, setScrollTooltip] = useState<TooltipKind | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showScrollTooltip = useCallback((kind: TooltipKind) => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setScrollTooltip(kind);
    tooltipTimerRef.current = setTimeout(() => setScrollTooltip(null), 1500);
  }, []);
  const hideScrollTooltip = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = null;
    setScrollTooltip(null);
  }, []);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ——「到最新」尾随窗口：smooth 滚动期间流式输出继续长高会滚不到底（目标
  // scrollHeight 是调用瞬间的快照）。窗口期（2.5s）内每次内容/滚动变化都
  // instant 钉底；到期或用户打断（wheel 上滚/触摸/向上键）后由 core follow
  // 接管——贴底状态在 core SCROLL_BOTTOM_THRESHOLD=150 内，
  // handleScrollPositionChange 会自动 userScrolledAway=false 重挂 follow，
  // 与内置「到最新」语义一致。纯事件驱动，无轮询。——
  // ——「到最早」钉顶窗口：镜像 tail-follow。revealHistory 全量展开后头部
  // 仍有渲染/图片加载导致的 scrollHeight 渐增，窗口期内持续 scrollTo(0)，
  // 直到稳定或用户打断（wheel 下滚/触摸/向下键）。——
  const tailFollowUntilRef = useRef(0);
  const earliestFollowUntilRef = useRef(0);
  // 导航代际：reveal 重跑 / sentinel 兑底 / 尾随钉底的延迟回调执行前检查，
  // 用户已点别的导航则放弃，防慢回调与新点击竞争把视口拉走。
  const navSeqRef = useRef(0);
  const cancelTailFollow = useCallback(() => { tailFollowUntilRef.current = 0; }, []);
  const cancelEarliestFollow = useCallback(() => { earliestFollowUntilRef.current = 0; }, []);

  // —— 滚动锚点跟踪（端口 core ChatMinimap 的 ResizeObserver 双通道 +
  // core handleScrollBoxRef 的「容器延迟挂载」对策）：——
  // · document capture 监听 scroll（scroll 不冒泡但捕获可达）→ 一次绑定，
  //   容器何时挂载/替换都收得到（欢迎页 isEmptyNew 时 [data-chat-scroll]
  //   不存在，首条消息后才出现——旧版挂载时绑一次会永久失灵）；
  // · MutationObserver（childList+subtree，rAF 合并）发现容器身份变化 →
  //   重挂 RO + 立即重算；
  // · ResizeObserver 观察容器 content-box（clientHeight/padding 变化，如
  //   bottomEyeRoom）+ 内容首元素（流式增长/懒加载变高）→ 内容变化不必等
  //   scroll 事件（内容增长不触发 scroll，core 注释原话）即刷新按钮显隐。
  const trackedContainerRef = useRef<HTMLDivElement | null>(null);
  const trackedContentRef = useRef<Element | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const recomputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncFrameRef = useRef<number | null>(null);

  // —— hover 感知层：透明层常驻，按钮隐藏后指针停在该区域也能唤出 ——
  const mousePosRef = useRef({ x: -9999, y: -9999 });
  const toolbarRectRef = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      const r = toolbarRectRef.current;
      if (!r) return;
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setScrollBtnsHovered(inside);
    };
    window.addEventListener("mousemove", onMouseMove);
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, []);

  // —— 常亮 toast + 会话内提示次数（每页刷新重置） ——
  const [keepAwakeToast, setKeepAwakeToast] = useState(false);
  const keepAwakeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipShowCountRef = useRef(0);
  const keepAwakeToastCountRef = useRef(0);
  const [keepAwake, setKeepAwake] = useState(false);
  const wakeLockSupported = useWakeLock(keepAwake && agentRunning);

  // —— 长按「到最新」切换常亮 ——
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);
  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }, []);

  // —— 整条工具条拖拽换位（按下后 window 级全局监听，手指离开按钮列不中断）——
  const onToolbarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startY0: pos.y, moved: false, pointerId: e.pointerId };
    dragModeRef.current = true;
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      drag.moved = true;
      try { ev.preventDefault(); } catch { /* ignore */ }
      clearLongPress();
      const el = toolbarRef.current;
      if (!el) return;
      const maxY = Math.max(8, window.innerHeight - el.offsetHeight - 8);
      const ny = Math.min(Math.max(8, drag.startY0 + dy), maxY);
      const nx = ev.clientX < window.innerWidth / 2 ? "left" : "right";
      setPosAndRef({ align: nx, y: ny });
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      const wasDrag = drag.moved;
      dragRef.current = null;
      dragModeRef.current = false;
      if (wasDrag) {
        try { localStorage.setItem("pi-scroll-toolbar-pos", JSON.stringify({ align: posRef.current.align, y: posRef.current.y })); } catch { /* ignore */ }
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [pos.y, clearLongPress, setPosAndRef]);

  // 纯状态重算（scroll / RO / 尾随补滚共用；不激活「滚动中」显示）。
  const recomputeAnchors = useCallback(() => {
    const c = trackedContainerRef.current;
    if (!c || !c.isConnected) return;
    const atTop = c.scrollTop <= SCROLL_ANCHOR_THRESHOLD;
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight <= SCROLL_ANCHOR_THRESHOLD;
    setScrollAnchors((prev) => (prev.atTop === atTop && prev.atBottom === atBottom ? prev : { atTop, atBottom }));
    if (Date.now() < tailFollowUntilRef.current) {
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (dist > 4) c.scrollTo({ top: c.scrollHeight, behavior: "auto" }); // instant 钉底，窗口到期/打断前持续跟随
    }
    if (Date.now() < earliestFollowUntilRef.current) {
      // 钉顶：revealHistory 后头部渲染/图片加载使 scrollHeight 渐增，保持贴住最旧
      if (c.scrollTop > 0) c.scrollTo({ top: 0, behavior: "auto" });
    }
  }, []);
  // RO/重算节流（端口 minimap measureThrottle 150ms）。
  const scheduleRecompute = useCallback(() => {
    if (recomputeTimerRef.current) return;
    recomputeTimerRef.current = setTimeout(() => {
      recomputeTimerRef.current = null;
      recomputeAnchors();
    }, 120);
  }, [recomputeAnchors]);

  const observeContainer = useCallback((c: HTMLDivElement) => {
    roRef.current?.disconnect();
    // 换容器/重建观察时两个跟随窗口一并作废：旧容器上的钉顶/尾随对新人无意义，
    // 否则切会话后残留窗口与 core follow 拔河最长 8s。
    tailFollowUntilRef.current = 0;
    earliestFollowUntilRef.current = 0;
    const ro = new ResizeObserver(scheduleRecompute);
    ro.observe(c); // 容器 content-box：clientHeight / paddingBottom（bottomEyeRoom）变化
    trackedContainerRef.current = c;
    trackedContentRef.current = null;
    const content = c.firstElementChild;
    if (content) {
      ro.observe(content); // 内容元素：流式增长 / 懒加载变高
      trackedContentRef.current = content;
    }
    roRef.current = ro;
    recomputeAnchors();
  }, [scheduleRecompute, recomputeAnchors]);

  const syncContainer = useCallback(() => {
    const next = document.querySelector<HTMLDivElement>("[data-chat-scroll]");
    if (next && next === trackedContainerRef.current) {
      // 防御：跟踪态但 RO 缺失（StrictMode 重跑窗口/异常态）→ 重建观察
      if (!roRef.current) {
        observeContainer(next);
        return;
      }
      // 内容元素可能被 React 整体替换（切会话/重挂）——保持观察不脱靶
      const content = next.firstElementChild;
      if (content && content !== trackedContentRef.current) {
        trackedContentRef.current = content;
        roRef.current?.observe(content);
      }
      return;
    }
    if (!next && !trackedContainerRef.current) return;
    if (next) {
      observeContainer(next);
    } else {
      roRef.current?.disconnect();
      roRef.current = null;
      trackedContainerRef.current = null;
      trackedContentRef.current = null;
      tailFollowUntilRef.current = 0;
      earliestFollowUntilRef.current = 0;
      setScrollAnchors((prev) => (prev.atTop && prev.atBottom ? prev : { atTop: true, atBottom: true }));
    }
  }, [observeContainer]);

  // 导航目标容器：跟踪缓存优先（由 scroll/RO/MO 维持新鲜），失联时兜底重发现。
  const getContainer = useCallback((): HTMLDivElement | null => {
    if (trackedContainerRef.current?.isConnected) return trackedContainerRef.current;
    const next = document.querySelector<HTMLDivElement>("[data-chat-scroll]");
    if (next && next !== trackedContainerRef.current) observeContainer(next);
    return trackedContainerRef.current;
  }, [observeContainer]);

  const handleScrollEvent = useCallback((e: Event) => {
    if (e.target !== trackedContainerRef.current) syncContainer(); // 容器替换/首次出现顺带发现
    recomputeAnchors();
    // 仅容器自身滚动激活「滚动中」显示：消息内代码块/minimap 等内层滚动体
    // 的 scroll 事件（capture 可达）不应亮起导航条。
    if (e.target === trackedContainerRef.current) {
      setScrollActive(true);
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = setTimeout(() => setScrollActive(false), 2000);
    }
  }, [recomputeAnchors, syncContainer]);

  useEffect(() => {
    syncContainer();
    const onScroll = (e: Event) => handleScrollEvent(e);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const mo = new MutationObserver(() => {
      // rAF 合并：childList 变更（新消息/工具块增减）每帧至多发现一次
      if (syncFrameRef.current !== null) return;
      syncFrameRef.current = requestAnimationFrame(() => {
        syncFrameRef.current = null;
        syncContainer();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      mo.disconnect();
      roRef.current?.disconnect();
      roRef.current = null;
      // 跟踪态一并清空：StrictMode（dev 双挂载）/ effect 重跑后，syncContainer
      // 走「未跟踪」分支重建 RO——只 disconnect 不清态会让重挂后的「已跟踪」
      // 分支跳过重建，RO 通道静默死亡（scroll 通道正常，极难察觉）。
      trackedContainerRef.current = null;
      trackedContentRef.current = null;
      if (recomputeTimerRef.current) { clearTimeout(recomputeTimerRef.current); recomputeTimerRef.current = null; }
      if (syncFrameRef.current !== null) { cancelAnimationFrame(syncFrameRef.current); syncFrameRef.current = null; }
    };
  }, [handleScrollEvent, syncContainer]);

  // 会话切换（容器 div 常被复用，身份不变）：清两个跟随窗口 + 重发现容器，
  // 防残留钉顶/尾随在新会话里与 core follow 拔河最长 8s。
  const sessionId = props.sessionId;
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    tailFollowUntilRef.current = 0;
    earliestFollowUntilRef.current = 0;
    syncFrameRef.current !== null && (cancelAnimationFrame(syncFrameRef.current), syncFrameRef.current = null);
    syncContainer();
  }, [sessionId, syncContainer]);

  // 两个跟随窗口的用户打断信号：wheel 上滚/向上键打断「到最新」，wheel 下滚/
  // 向下键打断「到最早」，触摸两者都打断。判定粒度与 core markUserScrollIntent 一致。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) cancelTailFollow();
      else if (e.deltaY > 0) cancelEarliestFollow();
    };
    const onTouchStart = () => { cancelTailFollow(); cancelEarliestFollow(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") cancelTailFollow();
      if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End") cancelEarliestFollow();
    };
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [cancelTailFollow, cancelEarliestFollow]);

  // 卸载清理全部定时器
  useEffect(() => () => {
    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    if (keepAwakeToastTimerRef.current) clearTimeout(keepAwakeToastTimerRef.current);
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  }, []);

  const showScrollButtons = (!scrollAnchors.atTop || !scrollAnchors.atBottom) && (scrollActive || (!isMobile && scrollBtnsHovered));

  // —— 工具条 viewport rect 缓存（hover 感知用；位置/布局/显隐变化时重读）——
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      toolbarRectRef.current = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      const m = mousePosRef.current;
      if (m.x >= r.left && m.x <= r.right && m.y >= r.top && m.y <= r.bottom) setScrollBtnsHovered(true);
    };
    read();
    const onResize = () => {
      const el2 = toolbarRef.current;
      if (!el2) return;
      const rr = el2.getBoundingClientRect();
      toolbarRectRef.current = { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom };
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos.align, pos.y, isMobile, showScrollButtons]);

  const scrollToEarliest = useCallback(() => {
    const c = getContainer();
    if (!c) return;
    cancelTailFollow();
    navSeqRef.current += 1; // 拦下 prev 的延迟重试（与「到最新」同待遇）
    if (revealHistoryRef.current) {
      // minimap 同款：一次性全量展开（已加载范围）+ 钉顶窗口盖住展开期间的
      // scrollHeight 渐增。注：core 另有服务端分页（hasEarlierMessages），
      // 若历史未拉全，需钉顶窗口与 sentinel 拉取的进/出变迁逐页收敛，
      // 深史可能需再点一次续 8s。
      earliestFollowUntilRef.current = Date.now() + 8000;
      revealHistoryRef.current();
      c.scrollTo({ top: 0, behavior: "auto" });
      recomputeAnchors();
    } else {
      // 旧 core 兑底：滚到 0，容器顶部 sentinel 经 IntersectionObserver 逐页加载。
      c.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [getContainer, cancelTailFollow, recomputeAnchors]);

  const scrollToLatest = useCallback(() => {
    const c = getContainer();
    if (!c) return;
    // 双向取消：earliest 钉顶窗口存续时点「到最新」不取消会顶底乒乓；
    // 同时 bump 导航代际，拦下 prev 的延迟重试拽走尾随中的视口。
    cancelEarliestFollow();
    navSeqRef.current += 1;
    // 开尾随窗口：smooth 期间流式输出继续长高时由 recomputeAnchors instant 追平。
    tailFollowUntilRef.current = Date.now() + 2500;
    c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
    recomputeAnchors();
  }, [getContainer, recomputeAnchors, cancelEarliestFollow]);

  // —— 跳转后露出目标消息的操作菜单（mouseover 模拟，与 core 消息 hover 行为一致）——
  const revealActionMenu = useCallback((el: HTMLElement) => {
    try {
      const menuTarget = (el.firstElementChild ?? el) as HTMLElement;
      if (lastNavTargetRef.current && lastNavTargetRef.current !== menuTarget) {
        lastNavTargetRef.current.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      }
      menuTarget.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      lastNavTargetRef.current = menuTarget;
    } catch { /* ignore */ }
  }, []);

  // —— prev/next 用户消息导航（端口自 core ScrollToolbar，改 DOM 发现）——
  const scrollToUserMessageRef = useRef<((dir: -1 | 1) => void) | null>(null);
  const prevRevealUsedRef = useRef(false);
  const scrollToUserMessage = useCallback((dir: -1 | 1) => {
    const seq = ++navSeqRef.current;
    const c = getContainer();
    if (!c) return;
    cancelTailFollow();
    cancelEarliestFollow(); // 显式导航优先；prev 的 reveal 路径下方会重新开钉顶窗口
    const allEls = getMsgEls(c);
    if (allEls.length === 0) return;
    const userEls = getUserEls(c);

    if (dir === -1) {
      // prev：锚点 = 视口顶部之上/附近的最后一个用户消息（正在读的问题）。
      // 它在视口内可见 → 跳它的前一条；在视口上方 → 直接跳到它。
      let anchor = -1;
      const limit = c.scrollTop + 8;
      for (let i = 0; i < userEls.length; i++) {
        const t0 = elTopInContainer(userEls[i], c);
        if (t0 < 0) continue;
        if (t0 <= limit + 4) { anchor = i; continue; }
        if (anchor === -1) anchor = i;
        break;
      }
      if (anchor === -1) anchor = userEls.length - 1;
      const anchorEl = userEls[anchor];
      const anchorTop = elTopInContainer(anchorEl, c);
      const anchorVisible = anchorTop >= c.scrollTop;
      const start = anchorVisible ? anchor - 1 : anchor;
      for (let i = start; i >= 0; i--) {
        const el = userEls[i];
        if (!el || !el.isConnected) continue;
        const t0 = elTopInContainer(el, c);
        if (t0 < 0) continue;
        c.scrollTo({ top: Math.max(0, t0 - 24), behavior: "smooth" });
        revealActionMenu(el);
        prevRevealUsedRef.current = false; // 跳转成功，下次窗口外仍可再 reveal
        return;
      }
    } else {
      // next：锚点 = 视口顶部处/下方第一条消息（任意角色），跳其后第一个用户消息。
      let anchor = -1;
      for (let i = 0; i < allEls.length; i++) {
        const el = allEls[i];
        if (!el || !el.isConnected) continue;
        const t0 = elTopInContainer(el, c);
        if (t0 < 0) continue;
        if (t0 >= c.scrollTop) { anchor = i; break; }
      }
      if (anchor === -1) anchor = allEls.length - 1;
      for (let i = anchor + 1; i < allEls.length; i++) {
        const el = allEls[i];
        if (!el || !el.isConnected || el.getAttribute("data-chat-msg-role") !== "user") continue;
        const t0 = elTopInContainer(el, c);
        if (t0 < 0) continue;
        c.scrollTo({ top: Math.max(0, t0 - 24), behavior: "smooth" });
        revealActionMenu(el);
        return;
      }
      // 例外：后面没有更多用户输入了 —— 连点 next 应一路走到页面最末
      // （最后一条消息的底部，通常是其后的 AI 回复末尾）。已在底部则停。
      // 流式期间开短尾随窗口保证真贴底。
      const distEnd = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (distEnd > 4) {
        cancelEarliestFollow(); // 同「到最新」：先关钉顶窗口，防顶底乒乓
        tailFollowUntilRef.current = Date.now() + 1500;
        c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
        recomputeAnchors();
      }
    }
    // 渲染窗口内没有更早的用户消息了 —— 优先 minimap 同款：revealHistory 一次性
    // 全量展开后重试（目标必在 DOM；重试仅一次，大会话渲染慢时不无限循环），
    // 无该通道（旧 core）才退回「诱使 sentinel 重载」逐页兑底：sentinel 的
    // IntersectionObserver 只在交叉状态变化时触发，已经滚在顶部不会重载，
    // 所以要「离开顶部再回来」；每周期加载一页，最多 3 页。
    if (dir === -1) {
      if (revealHistoryRef.current && !prevRevealUsedRef.current) {
        prevRevealUsedRef.current = true;
        earliestFollowUntilRef.current = Date.now() + 8000;
        revealHistoryRef.current();
        // 双 rAF：等 React commit 全量渲染后再查找跳转（窗口已钉顶住渐增）
        requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => { if (navSeqRef.current === seq) scrollToUserMessageRef.current?.(-1); }, 60);
        }));
        return;
      }
      let attempts = 0;
      const retry = async () => {
        attempts += 1;
        if (attempts > 3) return;
        if (navSeqRef.current !== seq) return; // 用户已点别的导航，整个循环放弃
        cancelEarliestFollow(); // 免得自家钉顶把 300px excursion 拉回，sentinel 观察不到进/出变迁
        const c2 = getContainer();
        if (!c2) return;
        const h0 = c2.scrollHeight;
        c2.scrollTo({ top: Math.min(c2.scrollHeight, 300), behavior: "auto" });
        await new Promise((r) => setTimeout(r, 90));
        c2.scrollTo({ top: 0, behavior: "auto" });
        // 等 scrollHeight 变化（intersection 回调异步，页面预插后容器变高）
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (navSeqRef.current !== seq) return; // 等待期间新导航，中断
          if (i >= 2 && c2.scrollHeight !== h0) break;
        }
        if (getContainer()?.scrollHeight === h0) return; // 没加载出来（已到最早）
        setTimeout(() => { if (navSeqRef.current === seq) scrollToUserMessageRef.current?.(-1); }, 120);
      };
      retry();
    }
  }, [revealActionMenu, getContainer, cancelTailFollow, cancelEarliestFollow, recomputeAnchors]);
  scrollToUserMessageRef.current = scrollToUserMessage;

  const onHover = useCallback((kind: TooltipKind) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (tooltipShowCountRef.current < 3) {
      tooltipShowCountRef.current += 1;
      showScrollTooltip(kind);
    }
    e.currentTarget.style.background = "var(--bg-hover)";
    e.currentTarget.style.color = "var(--text)";
  }, [showScrollTooltip]);
  const onHoverOut = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    hideScrollTooltip();
    e.currentTarget.style.background = "color-mix(in srgb, var(--bg-panel) 92%, transparent)";
    e.currentTarget.style.color = "var(--text-muted)";
  }, [hideScrollTooltip]);

  if (!showToolbar) return null;

  const latestBtnStyle: React.CSSProperties = {
    ...btnBase,
    border: keepAwake ? "1px solid color-mix(in srgb, var(--accent) 55%, var(--border))" : "1px solid var(--border)",
    background: keepAwake ? "color-mix(in srgb, var(--accent) 18%, var(--bg-panel))" : "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
    color: keepAwake ? "var(--accent)" : "var(--text-muted)",
    boxShadow: "0 2px 8px rgba(15,23,42,0.22)",
  };

  return (
    <div
      ref={toolbarRef}
      style={{
        position: "absolute",
        left: pos.align === "left" ? 12 : undefined,
        right: pos.align === "right"
          ? (isMobile ? 12 : `max(${CHAT_MINIMAP_WIDTH + 12}px, calc((100% - 820px) / 2 - 12px))`)
          : undefined,
        top: pos.y,
        width: TOOLBAR_W,
        // hover 感知层：常驻（按钮隐藏后仍可把指针停在原位唤出）；pointerEvents:none 纯传感
        minHeight: TOOLBAR_MIN_H,
        zIndex: 30,
        pointerEvents: "none",
        touchAction: "none",
      }}
    >
      {showScrollButtons && (
        <div
          onPointerDown={onToolbarPointerDown}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            position: "relative",
            zIndex: 30,
            pointerEvents: "auto",
            cursor: dragModeRef.current ? "grabbing" : "grab",
            touchAction: "none",
          }}
        >
          <button
            aria-label="scrollToEarliest"
            onClick={scrollToEarliest}
            onMouseEnter={onHover("earliest")}
            onMouseLeave={onHoverOut}
            style={btnBase}
          >
            <ArrowUp />
          </button>
          <button
            aria-label="scrollToPrevUser"
            onClick={() => {
              if (tapNavigatedRef.current) { tapNavigatedRef.current = false; return; }
              scrollToUserMessage(-1);
            }}
            onPointerUp={() => {
              const drag = dragRef.current;
              if (drag && !drag.moved) {
                tapNavigatedRef.current = true;
                scrollToUserMessage(-1);
              }
            }}
            onMouseEnter={onHover("prevUser")}
            onMouseLeave={onHoverOut}
            style={btnBase}
          >
            <PrevUserIcon />
          </button>
          <button
            aria-label="scrollToNextUser"
            onClick={() => {
              if (tapNavigatedRef.current) { tapNavigatedRef.current = false; return; }
              scrollToUserMessage(1);
            }}
            onPointerUp={() => {
              const drag = dragRef.current;
              if (drag && !drag.moved) {
                tapNavigatedRef.current = true;
                scrollToUserMessage(1);
              }
            }}
            onMouseEnter={onHover("nextUser")}
            onMouseLeave={onHoverOut}
            style={btnBase}
          >
            <NextUserIcon />
          </button>
          {/* 60px 命中区包裹长按手势（视觉按钮仍 44px 居中） */}
          <div
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 60,
              height: 60,
              margin: -8,
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
            onPointerDown={(e) => {
              // 长按(>600ms)切换常亮；短按仍跳到最新。NOTE：不能 preventDefault
              //（移动端会吞掉后续 click）。stopPropagation：长按时手指微动不触发拖拽。
              e.stopPropagation();
              clearLongPress();
              if (!keepAwakeFeature || !wakeLockSupported) return;
              longPressTimerRef.current = setTimeout(() => {
                didLongPressRef.current = true;
                const nowOn = !keepAwake;
                setKeepAwake(nowOn);
                document.getSelection()?.removeAllRanges();
                const prev = document.body.style.userSelect;
                document.body.style.userSelect = "none";
                if (nowOn && keepAwakeToastCountRef.current < 3) {
                  keepAwakeToastCountRef.current += 1;
                  setKeepAwakeToast(true);
                }
                if (keepAwakeToastTimerRef.current) clearTimeout(keepAwakeToastTimerRef.current);
                keepAwakeToastTimerRef.current = setTimeout(() => {
                  setKeepAwakeToast(false);
                  document.body.style.userSelect = prev;
                }, 2000);
              }, 600);
            }}
            onPointerUp={clearLongPress}
            onPointerCancel={clearLongPress}
            onPointerLeave={clearLongPress}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              aria-label="scrollToLatest"
              onClick={() => {
                if (didLongPressRef.current) { didLongPressRef.current = false; return; }
                scrollToLatest();
              }}
              onMouseEnter={(e) => {
                if (tooltipShowCountRef.current < 3) {
                  tooltipShowCountRef.current += 1;
                  showScrollTooltip("latest");
                }
                e.currentTarget.style.background = keepAwake
                  ? "color-mix(in srgb, var(--accent) 26%, var(--bg-panel))"
                  : "var(--bg-hover)";
                e.currentTarget.style.color = keepAwake ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                hideScrollTooltip();
                e.currentTarget.style.background = keepAwake
                  ? "color-mix(in srgb, var(--accent) 18%, var(--bg-panel))"
                  : "color-mix(in srgb, var(--bg-panel) 92%, transparent)";
                e.currentTarget.style.color = keepAwake ? "var(--accent)" : "var(--text-muted)";
              }}
              style={latestBtnStyle}
            >
              <ArrowDown />
            </button>
          </div>
        </div>
      )}
      {scrollTooltip && (
        <div
          style={{
            position: "absolute",
            right: "calc(100% + 10px)",
            top: tooltipTop[scrollTooltip],
            whiteSpace: "nowrap",
            fontSize: 12,
            color: "var(--text)",
            background: "color-mix(in srgb, var(--bg-panel) 96%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 8px",
            boxShadow: "0 2px 10px rgba(15,23,42,0.25)",
            pointerEvents: "none",
            zIndex: 31,
          }}
        >
          {t(scrollTooltip === "latest" ? "nav.latestHint" : `nav.${scrollTooltip}`)}
        </div>
      )}
      {keepAwakeToast && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
            fontSize: 13,
            color: "var(--text)",
            background: "color-mix(in srgb, var(--bg-panel) 96%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))",
            borderRadius: 8,
            padding: "6px 14px",
            boxShadow: "0 2px 12px rgba(15,23,42,0.25)",
            pointerEvents: "none",
            textAlign: "center",
            maxWidth: "min(80vw, 480px)",
          }}
        >
          {t("nav.keepAwakeOn")}
        </div>
      )}
    </div>
  );
}
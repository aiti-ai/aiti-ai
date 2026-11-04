/**
 * aiti-msg-anchor · 消息锚点横幅组件
 *
 * 行为：消息区顶部常驻一条浮层横幅，展示「当前视口所属的用户输入」——
 *   每个用户输入与其后的 AI 回复构成一个「回合段」；滚动时横幅跟随当前视口
 *   顶部边界所在的回合段（display.mode = current，默认）。
 *   可切换为：会话第一条输入（first）/ 最近一条输入（latest）/ 会话标题（title）。
 *
 * 可见性（与用户约定的行为）：
 *   - 滚动时显示，停止滚动 6s 后淡出（初始可见 6s，之后靠滚动唤醒）；
 *   - 锚点用户输入已在视口内 → 不显示（输入都看见了，横幅无参考意义）；
 *   - 右对齐到消息列右缘（消息尾部），暂时代替看不见的用户输入的位置。
 *
 * 两行布局（display.title / display.input 分别开关，默认同开）：
 *   - 第一行：session 名；没有 session 名 → 取会话第一条用户输入（与左侧 session 列表标题一致：name || firstMessage）。
 *   - 第二行：按 display.mode 计算的当前输入（current/first/latest）。
 *   - 两行内容相同时（第一行兜底=第一条输入且当前输入就是第一条）只显示一行，不重复。
 *
 * DOM 契约（与 aiti-msg-nav 同源，两条即可工作，零核心依赖）：
 *   - [data-chat-scroll]     消息滚动容器
 *   - [data-chat-msg-role]   消息包装节点（role="user" 即锚点目标）
 *   会话标题经 chatOverlay 插槽的 currentSession 透传（ChatWindow 已带）。
 *
 * 性能：滚动帧零布局读取——用户消息在内容流中的位置（topFlow）只在 DOM
 *   变化/容器尺寸变化时批量重建缓存（节流 ~150ms），滚动时只对缓存做二分。
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { getFeatures, onFeatureChange, t } from "./host-shim";

/** 滚动帧节流：位置缓存命中时的二分查找（无 getBoundingClientRect）。 */
const REBUILD_DEBOUNCE_MS = 150;
/** 视口顶部判定线的偏移（容器 pt-4=16px 顶内边距 + 少量余量：
 *  使 scrollTop=0 时第一条用户消息能被正常命中，而不是靠回退）。 */
const TOP_EPSILON = 24;
/** 滚动停止后自动隐藏的延迟（滚动时显示，停止 6s 后淡出）。 */
const HIDE_AFTER_MS = 6000;

interface Section {
  el: HTMLElement;
  /** 用户消息在滚动内容流中的位置（不随滚动变化；DOM 变化时重建）。 */
  topFlow: number;
}

type Mode = "current" | "first" | "latest" | "title";

function findScrollEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-chat-scroll]");
}

function getUserEls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-chat-msg-role='user']")).filter((el) => el.isConnected);
}

function buildSections(container: HTMLElement): Section[] {
  const cRect = container.getBoundingClientRect();
  return getUserEls(container).map((el) => ({
    el,
    topFlow: el.getBoundingClientRect().top - cRect.top + container.scrollTop,
  }));
}

/** 二分：最后一个 topFlow <= limit 的段（视口顶部边界所在回合段；无则回退第 0 段）。 */
function sectionAt(sections: Section[], limit: number): Section {
  let lo = 0;
  let hi = sections.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].topFlow <= limit) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return sections[ans];
}

/** 锚点用户输入是否已出现在视口内（任意重叠即算可见——已看到输入，横幅无参考意义）。 */
function isElVisibleIn(container: HTMLElement, el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const cr = container.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  return er.bottom > cr.top && er.top < cr.bottom;
}

function extractText(el: HTMLElement): string {
  // 优先取渲染的 markdown 正文容器（用户消息 = .markdown-user-message/.markdown-body），
  // 避开同级操作区（Copy/引用/收藏/Edit from here/New session）与时间戳。
  const md = el.querySelector<HTMLElement>(".markdown-user-message, .markdown-body");
  if (md && md.textContent?.trim()) {
    return md.textContent.replace(/\s+/g, " ").trim();
  }
  // 兜底：克隆后剥掉按钮/图标/时间戳再取文本
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button, svg, [class*='timestamp']").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 截断：超出 maxLen 补省略号。 */
function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0 || text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/** 定位图标（lucide map-pin 风格）。 */
function PinIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function MsgAnchorBanner(props: {
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  isMobile?: boolean;
}) {
  const { currentSession } = props;
  const isMobile = typeof props.isMobile === "boolean" ? props.isMobile : typeof window !== "undefined" && window.innerWidth < 768;

  // 功能开关（extman 管理；变更触发重渲染）
  const [, force] = useState(0);
  useEffect(() => onFeatureChange(() => force((v) => v + 1)), []);

  const [anchor, setAnchor] = useState<{ text: string; index: number; total: number; el: HTMLElement | null } | null>(null);
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sectionsRef = useRef<Section[]>([]);
  const containerRef = useRef<HTMLElement | null>(null);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const features = getFeatures();
  const showBanner = features["show.banner"] !== false;
  const showTitle = features["display.title"] !== false; // 第一行：会话标题
  const showInput = features["display.input"] !== false; // 第二行：当前输入
  const mode = (String(features["display.mode"] ?? "current") || "current") as Mode;
  const maxLen = (() => {
    const n = parseInt(String(features["text.maxLen"] ?? "140"), 10);
    return Number.isFinite(n) && n > 0 ? n : 140;
  })();
  // 横幅不透明度（0-100）：可见时叠加此值（淡出时仍为 0）；非法值回退 85
  const opacity = (() => {
    const n = parseInt(String(features["display.opacity"] ?? "85"), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 0.85;
  })();

  // ── 计算当前锚点（纯函数，读缓存 sections） ────────────────────────
  const computeAnchor = (container: HTMLElement): { text: string; index: number; total: number; el: HTMLElement | null } | null => {
    const sections = sectionsRef.current;
    if (sections.length === 0) {
      // title 模式不依赖消息段（无消息时用 session 名 / 第一条用户输入，与 session 列表标题一致）
      if (mode === "title") {
        const text = currentSession?.name || currentSession?.firstMessage || "";
        if (!text) return null;
        return { text, index: -1, total: 0, el: null };
      }
      return null;
    }
    if (mode === "first") {
      const s = sections[0];
      return { text: extractText(s.el), index: 0, total: sections.length, el: s.el };
    }
    if (mode === "latest") {
      const s = sections[sections.length - 1];
      return { text: extractText(s.el), index: sections.length - 1, total: sections.length, el: s.el };
    }
    if (mode === "title") {
      // 会话标题 = session 名；无名 → 第一条用户输入（与左侧 session 列表标题一致）
      const text = currentSession?.name || currentSession?.firstMessage || "";
      if (!text) return null;
      return { text, index: -1, total: sections.length, el: null };
    }
    // current：视口顶部边界所在的回合段。用顶部而非中心线——中心线会把
    // 短的首段（输入+回复合计 < 半个视口高）直接跳过：滚到最顶也显示第二段。
    // 顶部边界对齐：顶部看到哪条输入的内容（或正接近下一条输入），就显示哪条。
    const limit = container.scrollTop + TOP_EPSILON;
    const s = sectionAt(sections, limit);
    const idx = sections.indexOf(s);
    return { text: extractText(s.el), index: idx, total: sections.length, el: s.el };
  };

  const apply = (fromScroll: boolean) => {
    const container = containerRef.current;
    if (!container || !container.isConnected) return;
    const next = computeAnchor(container);
    setAnchor((prev) => {
      if (next === null && prev === null) return prev;
      if (next && prev && next.text === prev.text && next.index === prev.index && next.total === prev.total) return prev;
      return next;
    });
    // 可见性：锚点输入已在屏幕内 → 隐藏（消息都看见了，横幅还显示啥）；
    // 否则滚动时才显示（参考用途：顶部有大段输出、看不到属于哪条输入时给个提示）。
    if (next?.el && isElVisibleIn(container, next.el)) {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
      setVisible(false);
    } else if (fromScroll) {
      pokeVisible();
    }
  };

  // ── 可见性：滚动时显示，停止 HIDE_AFTER_MS 后淡出 ──────────────────
  const pokeVisible = () => {
    setVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  };

  // ── 挂载：找到滚动容器 → 建缓存 → 绑 scroll / mutation / resize ───
  useEffect(() => {
    let disposed = false;
    let container: HTMLElement | null = null;
    let mo: MutationObserver | null = null;
    let ro: ResizeObserver | null = null;
    let bodyMo: MutationObserver | null = null;
    let scrollTick = 0;

    // 初始可见（发现性），6s 无滚动后淡出；之后滚动重新出现
    pokeVisible();

    const rebuild = () => {
      if (disposed || !container) return;
      sectionsRef.current = buildSections(container);
      apply(false);
    };
    const scheduleRebuild = () => {
      if (rebuildTimerRef.current) clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = setTimeout(() => {
        rebuildTimerRef.current = null;
        rebuild();
      }, REBUILD_DEBOUNCE_MS);
    };

    const attach = () => {
      if (disposed) return;
      container = findScrollEl();
      if (!container) return false;
      containerRef.current = container;
      rebuild();

      mo = new MutationObserver(scheduleRebuild);
      mo.observe(container, { childList: true, subtree: true, characterData: true });

      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(scheduleRebuild);
        ro.observe(container);
      }

      container.addEventListener("scroll", onScroll, { passive: true });
      return true;
    };

    const onScroll = () => {
      if (scrollTick) return;
      scrollTick = requestAnimationFrame(() => {
        scrollTick = 0;
        apply(true);
      });
    };

    if (!attach()) {
      // 容器尚未出现（过渡态）：body 层 childList 观察重试
      bodyMo = new MutationObserver(() => {
        if (container) return;
        if (attach()) bodyMo?.disconnect();
      });
      bodyMo.observe(document.body, { childList: true, subtree: false });
    }

    return () => {
      disposed = true;
      if (scrollTick) cancelAnimationFrame(scrollTick);
      if (rebuildTimerRef.current) { clearTimeout(rebuildTimerRef.current); rebuildTimerRef.current = null; }
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
      mo?.disconnect();
      ro?.disconnect();
      bodyMo?.disconnect();
      if (container) container.removeEventListener("scroll", onScroll);
      containerRef.current = null;
      sectionsRef.current = [];
    };
  }, [currentSession?.id, mode, maxLen]);

  // ── 点击横幅 → 滚动到该用户输入 ─────────────────────────────────────
  const scrollToAnchor = () => {
    const el = anchor?.el;
    const container = containerRef.current;
    if (!el || !container || !el.isConnected) return;
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
  };

  if (!showBanner) return null;

  // 标题行（第一行）：session 名；没有 session 名 → 取会话第一条用户输入（与左侧 session 列表标题一致）。
  const sessionTitle = currentSession?.name || "";
  const isTitleMode = mode === "title";
  let titleLine = "";
  if (showTitle) {
    titleLine = isTitleMode ? (anchor?.text || "") : sessionTitle;
    // 与左侧 session 列表对齐：name || firstMessage（第一条用户输入，API 数据源而非 DOM 重建）
    if (!titleLine) titleLine = currentSession?.firstMessage || "";
  }
  // 输入行（第二行）：锚点输入（current/first/latest 模式；title 模式无独立输入行）
  const inputLine = showInput && !isTitleMode ? (anchor?.text || "") : "";
  // 第一行与第二行内容相同（无 session 名时第一行兜底=第一条输入，而当前输入正是第一条输入）
  // → 只显示第一行，避免重复展示（比较未截断原文）
  const sameAsTitle = titleLine !== "" && inputLine !== "" && titleLine === inputLine;
  // 渲染判定：不依赖 anchor 当前值（异步到达后重渲染）——
  //   title 模式唯一内容是标题行，标题关了就不渲染；
  //   其余模式任一展示开着就有内容来源（标题行含第一条输入兜底）。
  if (isTitleMode) {
    if (!showTitle) return null;
  } else if (!showInput && !showTitle) {
    return null;
  }

  const label =
    mode === "first" ? t("anchor.firstInput")
    : mode === "latest" ? t("anchor.latestInput")
    : mode === "title" ? t("anchor.sessionTitle")
    : t("anchor.currentInput");

  const chipStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 11.5,
    lineHeight: 1.4,
    color: "var(--text)",
    background: "color-mix(in srgb, var(--bg-panel) 94%, transparent)",
    border: "1px solid var(--border)",
    boxShadow: "0 2px 10px rgba(15,23,42,0.22)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    cursor: anchor?.el ? "pointer" : "default",
    pointerEvents: visible ? "auto" : "none",
    transition: "border-color 0.15s, background 0.15s",
    userSelect: "none",
  };
  const onHover = (over: boolean) => (e: MouseEvent) => {
    const s = e.currentTarget.style;
    s.borderColor = over ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)";
    s.background = over ? "color-mix(in srgb, var(--bg-panel) 97%, var(--accent))" : "color-mix(in srgb, var(--bg-panel) 94%, transparent)";
  };

  const titleParts: string[] = [];
  if (titleLine) titleParts.push(`${t("anchor.sessionTitle")}：${titleLine}`);
  if (inputLine && !sameAsTitle) titleParts.push(`${label}：${inputLine}`);
  if (anchor?.el && anchor.total > 1) titleParts.push(`#${anchor.index + 1}/${anchor.total}`);
  if (anchor?.el) titleParts.push(t("anchor.hint"));

  return (
    <div
      style={{
        position: "absolute",
        top: 2,
        left: 12,
        // 右缘对齐消息列右缘（消息尾部）：列宽 820 居中，滚动容器右侧被 36px minimap 占用；
        // 移动端无 minimap、列满宽（两侧 16px padding）→ 16。
        right: isMobile ? 16 : "max(52px, calc((100% - 784px) / 2))",
        display: "flex",
        justifyContent: "flex-end",
        pointerEvents: "none",
        zIndex: 30,
        opacity: visible ? opacity : 0,
        visibility: visible ? "visible" : "hidden",
        transition: "opacity 0.35s ease, visibility 0.35s",
        transform: visible ? "translateY(0)" : "translateY(-4px)",
      }}
    >
      <button
        type="button"
        aria-label={titleParts.join(" · ")}
        title={titleParts.join(" · ")}
        tabIndex={visible ? 0 : -1}
        onClick={scrollToAnchor}
        onMouseEnter={onHover(true)}
        onMouseLeave={onHover(false)}
        style={{ ...chipStyle, flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "5px 10px", borderRadius: 10 }}
      >
        {titleLine ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 480, overflow: "hidden" }}>
            <span style={{ display: "inline-flex", color: "var(--accent)", flexShrink: 0 }}>
              <PinIcon />
            </span>
            {/* 第一行：会话标题——加粗 + accent 强调色，与输入行明显区分 */}
            <span style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {truncate(titleLine, maxLen)}
            </span>
          </span>
        ) : null}
        {inputLine && !sameAsTitle ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 480, overflow: "hidden", paddingLeft: 19 }}>
            {/* 第二行：当前输入——muted 小字 + 省略号，仅作辅助参考 */}
            <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {truncate(inputLine, maxLen)}
            </span>
            {anchor?.el && anchor.total > 1 ? (
              <span style={{ color: "var(--text-muted)", flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
                {anchor.index + 1}/{anchor.total}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}

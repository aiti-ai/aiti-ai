/**
 * sidebar/parts —— SidebarDock 的基础 UI 部件（宿主 SessionSidebar 内部组件复制）。
 * 自包含：react hooks 经 host-shim 委托宿主；t 用扩展 i18n 表（index.ts ui.i18n）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../host-shim";
import { truncateRunErrorText, type SessionLastRun } from "./pure";
import { clampToViewport, fixedOrigin } from "../../../../_shared/popup-anchor";

/** 左省略路径标签（宿主 PathLabel 复制：rtl 容器让省略号出现在左侧）。 */
export function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

/** 小屏判定（≤640px，与宿主 float-full / compact 同断点）：
 *  下拉开场时筛选框不在小屏自动聚焦，避免手机弹键盘遮挡列表（用户点输入框再聚焦）。 */
export function isSmallScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
}

/** 下拉开场动画容器（宿主 AnimatedDropdown 复制；settle 后去 transform 释放 fixed 子元素）。
 *
 *  fixedAnchor 模式（2026-09-14，用户报「小屏切换 workspace 下拉被底部文件夹覆盖」）：
 *  弹层转 position:fixed 锚定在父元素（触发器 wrapper）下方——左栏 sidebar-container →
 *  DockStack StackCell → DockBody 全链 overflow:hidden，absolute 弹层在矮格/栈底格一律被
 *  祖先裁掉（弹层 rect 仍在视口内，视口钳位兜底探测不到），下方区块（文件夹/任务）于是
 *  「盖住」下拉底部；fixed 逃逸 overflow 裁剪，唯 transform/filter 祖先会成为 fixed 的
 *  containing block，坐标按其原点校正（_shared/popup-anchor 方案，aiti-folder 切换器先例）。
 *  下开、下方装不下且上方更大时上翻、视口钳制、随视口（旋转/软键盘）重算；高度超视口时
 *  内部滚动（根 flex 列 + 列表 flex:1 1 auto，筛选/操作行 flexShrink:0 由调用方标注）。 */
export function AnimatedDropdown({ open, children, style, fixedAnchor = false }: {
  open: boolean;
  children: ReactNode;
  style: CSSProperties;
  fixedAnchor?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [fixedPos, setFixedPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [, bumpLayout] = useState(0);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  // 视口变化（旋转/移动端软键盘/窗口 resize）→ 强制复测落位（fixed 坐标不随布局回流自动跟）。
  useEffect(() => {
    if (!fixedAnchor || !open) return;
    const onResize = () => bumpLayout((v) => v + 1);
    window.addEventListener("resize", onResize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      vv?.removeEventListener("resize", onResize);
    };
  }, [fixedAnchor, open]);

  // 每渲染复测（内容异步到齐/换行高度变化跟随；值不变即 bail 不循环）；useLayoutEffect
  // 绘制前同步，无闪烁。offsetWidth/Height 取布局尺寸——免疫开场 transform 的 scale 污染。
  useLayoutEffect(() => {
    if (!fixedAnchor || !mounted) return;
    const el = boxRef.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const width = Math.max(1, Math.round(a.width));
    el.style.width = `${width}px`; // 先落宽再量高（换行按最终宽度）
    el.style.maxHeight = `${Math.max(160, window.innerHeight - 16)}px`; // 视口兜底：超高内部滚
    const height = el.offsetHeight;
    if (height <= 0) return;
    const gap = 4, pad = 8;
    let top = a.bottom + gap;
    const below = window.innerHeight - pad - top;
    const above = a.top - gap - pad;
    if (height > below && above > below) top = a.top - gap - height; // 下方装不下且上方更大 → 上翻
    const c = clampToViewport(a.left, top, width, height, pad);
    const o = fixedOrigin(el);
    const next = { left: c.left - o.x, top: c.top - o.y, width };
    setFixedPos((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.width === next.width ? cur : next));
  });

  if (!mounted) return null;

  return (
    <div
      ref={boxRef}
      style={{
        ...style,
        ...(fixedAnchor
          ? {
              position: "fixed" as const,
              right: "auto",
              bottom: "auto",
              display: "flex",
              flexDirection: "column" as const,
              ...(fixedPos ? { left: fixedPos.left, top: fixedPos.top, width: fixedPos.width } : { left: -99999, top: -99999 }),
            }
          : null),
        opacity: visible ? 1 : 0,
        transform: visible ? "none" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

/** 运行中转圈（宿主 RunningSessionIndicator 复制）。 */
export function RunningSessionIndicator() {
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

/** 未读波点（宿主 UnreadSessionIndicator 复制）。 */
export function UnreadSessionIndicator() {
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * 会话运行终态异常标记（与宿主 SessionSidebar.RunOutcomeIndicator 同款；
 * completed 不渲染，运行中优先由调用方 !isRunning 门控）：
 * failed 红圈叹号（title 带错误摘要）/ aborted 灰方块 / interrupted 橙暂停。
 */
export function RunOutcomeIndicator({ run }: { run: SessionLastRun }) {
  const failed = run.status === "failed";
  const aborted = run.status === "aborted";
  const label = failed
    ? (run.error ? t("sm.runFailedWithError", { error: truncateRunErrorText(run.error, 80) }) : t("sm.runFailed"))
    : aborted
      ? t("sm.runAborted")
      : t("sm.runInterrupted");
  const color = failed ? "var(--danger, #ef4444)" : aborted ? "var(--text-dim)" : "var(--warn, #f59e0b)";
  return (
    <span
      title={label}
      aria-label={label}
      style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color }}
    >
      {failed ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" style={{ display: "block" }}>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="7.5" x2="12" y2="13" />
          <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
        </svg>
      ) : aborted ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: "block" }}>
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: "block" }}>
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      )}
    </span>
  );
}

/** 项目下拉条目的紧凑 activity 徽标（宿主 showProjectActivity 复制）。 */
export function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

/** 行右键菜单事件（宿主 lib/session-row-context-menu 复制：同事件名，宿主消费者照常接管）。 */
export const SESSION_ROW_CONTEXT_MENU_EVENT = "pi-web:session-row-contextmenu";

export interface SessionRowContextMenuDetail {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  clientX: number;
  clientY: number;
  refresh: () => void;
}

/** Returns true when a synchronous listener claims the context menu. */
export function dispatchSessionRowContextMenu(
  detail: SessionRowContextMenuDetail,
  target: EventTarget = window,
): boolean {
  const event = new CustomEvent<SessionRowContextMenuDetail>(SESSION_ROW_CONTEXT_MENU_EVENT, {
    cancelable: true,
    detail,
  });
  return !target.dispatchEvent(event);
}

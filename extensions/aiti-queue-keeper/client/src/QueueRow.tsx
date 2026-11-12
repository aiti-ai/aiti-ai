/**
 * QueueRow —— 队列行增强组件（从 core ChatInput 移植，消费 actions 原语）。
 *
 * 迁移来源：components/ChatInput.tsx 增强版 QueuedMessageRow（↑/↓/拖拽/steer-send/
 * 转 followUp/取回/删除）。差异：不接收 onXXX props，统一经 props.actions 原语调用；
 * isCoarsePointer 由核心传入（扩展无该 hook）。
 */
import { useRef } from "react";
import { t } from "./host-shim";
import type { QueuePanelActions, QueueImage } from "./types";

export interface QueueRowProps {
  kind: "steer" | "follow-up";
  text: string;
  /** 队列条目携带的图片（base64）：行内缩略图预览 + 插队直发带图。 */
  images?: QueueImage[];
  /** 附件标记（live 视图投影，脱 base64）：文本前图标用。 */
  hasImages?: boolean;
  /** 前向兼容：队列链路尚不支持文件附件，恒 false；未来 files 入队后自动生效。 */
  hasFiles?: boolean;
  index: number;
  total: number;
  actions: QueuePanelActions;
  /** 拖拽/触摸拖拽（与 core 同语义）。 */
  onDragStart?: (index: number) => void;
  onDragOver?: (index: number) => void;
  onDrop?: (targetIndex: number) => void;
  onTouchMoveTo?: (targetIndex: number) => void;
  dragging?: boolean;
  isCoarsePointer?: boolean;
  /** steer 只读（外部 agent 后端）：隐藏全部行级操作与拖拽，仅展示（提示见徽标 title）。 */
  steerReadonly?: boolean;
}

const iconBtn: Record<string, string | number> = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  flexShrink: 0,
};

/** 队列行附件图标（lucide image / paperclip）：消息文本前标记该条带图片/文件。 */
function AttachIcons({ hasImages, hasFiles }: { hasImages?: boolean; hasFiles?: boolean }) {
  if (!hasImages && !hasFiles) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, color: "var(--text-dim)" }}>
      {hasImages && (
        <span title={t("chat.queueHasImages")} style={{ display: "inline-flex", alignItems: "center" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </span>
      )}
      {hasFiles && (
        <span title={t("chat.queueHasFiles")} style={{ display: "inline-flex", alignItems: "center" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </span>
      )}
    </span>
  );
}

export function QueueRow({ kind, text, images, hasImages, hasFiles, index, total, actions, onDragStart, onDragOver, onDrop, onTouchMoveTo, dragging, isCoarsePointer, steerReadonly }: QueueRowProps) {
  // 外部 agent 后端的 steer 条目：已注入后端 CLI 进程，撤回/移动/转换均不被协议支持
  // （backend-queue 对 steer 管理操作一律报错）——隐藏全部操作仅展示。
  const ro = kind === "steer" && Boolean(steerReadonly);
  // 「插队此条目」的入口只在 core 下发 steerSend 时存在（存在即本会话有 steer 注入面）：
  // steer:false 的后端点了只会把条目 remove 掉而消息发不出去——静默吞输入，必须收起。
  const canSteerOut = Boolean(actions.steerSend);
  // 注意：扩展 host-shim 的 t() 走 ctx 委托（扩展 i18n 表）。
  // 行内取回（append 合并）→ actions.recallOne（core 置 edit-intent + 写值）
  const doRecall = () => { void actions.recallOne(kind === "follow-up" ? "followUp" : "steer", index); };
  const doRemove = (permanent: boolean) => { void actions.remove(kind === "follow-up" ? "followUp" : "steer", index, permanent ? { permanent: true } : undefined); };
  const doSteerSend = () => { actions.steerSend?.(text, images); doRemove(true); };
  const doConvert = () => { void actions.convert(kind === "steer" ? "steer" : "followUp", index, kind === "steer" ? "followUp" : "steer"); };
  const doMove = (dir: -1 | 1) => { void actions.move(kind === "steer" ? "steer" : "followUp", index, index + dir); };

  const canUp = index > 0;
  const canDown = index < total - 1;
  const coarse = Boolean(isCoarsePointer);
  // Touch drag state (mobile).
  const touchDragRef = useRef<{ y: number; moved: boolean } | null>(null);
  const touchOverElRef = useRef<HTMLElement | null>(null);
  const clearTouchOver = () => {
    if (touchOverElRef.current) {
      touchOverElRef.current.style.background = "";
      touchOverElRef.current.style.borderRadius = "";
      touchOverElRef.current = null;
    }
  };
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.target instanceof Element && e.target.closest("button")) return;
    e.stopPropagation();
    touchDragRef.current = { y: e.touches[0].clientY, moved: false };
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const d = touchDragRef.current;
    if (!d) return;
    const t = e.touches[0];
    const dy = t.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < 8) return;
      d.moved = true;
      const el = e.currentTarget as HTMLElement;
      el.style.opacity = "0.45";
      el.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)";
      el.style.borderRadius = "6px";
    }
    e.stopPropagation();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const row = el?.closest?.("[data-queue-row]");
    if (row && row !== e.currentTarget) {
      const target = row as HTMLElement;
      if (touchOverElRef.current !== target) {
        clearTouchOver();
        touchOverElRef.current = target;
        target.style.background = "color-mix(in srgb, var(--accent) 14%, transparent)";
        target.style.borderRadius = "6px";
      }
    } else if (touchOverElRef.current) {
      clearTouchOver();
    }
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const d = touchDragRef.current;
    touchDragRef.current = null;
    const rowEl = e.currentTarget as HTMLElement;
    rowEl.style.opacity = "";
    rowEl.style.background = "";
    rowEl.style.borderRadius = "";
    clearTouchOver();
    if (!d?.moved) return;
    e.stopPropagation();
    const el = document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    const row = el?.closest?.("[data-queue-row]") as HTMLElement | null;
    if (!row || row === e.currentTarget) return;
    const to = Number(row.dataset.queueIndex);
    if (!Number.isNaN(to) && to !== index && onTouchMoveTo) onTouchMoveTo(to);
  };

  return (
    <div
      title={text}
      data-queue-row="1"
      data-queue-kind={kind}
      data-queue-index={index}
      draggable={Boolean(onDragStart) && !coarse && !ro}
      onDragStart={(e) => {
        onDragStart?.(index);
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(index)); } catch { /* ignore */ }
      }}
      onDragOver={(e) => {
        if (!onDragOver) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver(index);
      }}
      onDrop={(e) => {
        if (!onDrop) return;
        e.preventDefault();
        onDrop(index);
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        cursor: onDragStart && !coarse ? "grab" : "default",
        ...(dragging
          ? { opacity: 0.45, background: "color-mix(in srgb, var(--accent) 8%, transparent)", borderRadius: 6 }
          : {}),
      }}
    >
      <span
        title={ro ? t("chat.queueSteerReadonly") : undefined}
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
          cursor: ro ? "help" : undefined,
        }}
      >
        {kind === "steer" ? t("chat.steer") : t("chat.followUp")}
      </span>
      <AttachIcons hasImages={hasImages || (images && images.length > 0)} hasFiles={hasFiles} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{text}</span>
      {images && images.length > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
          {images.slice(0, 4).map((im, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={`data:${im.mimeType};base64,${im.data}`}
              alt=""
              title={images.length > 4 ? `${images.length} 张图片` : "队列图片"}
              style={{ width: 22, height: 22, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)", display: "block" }}
            />
          ))}
          {images.length > 4 && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>+{images.length - 4}</span>
          )}
        </span>
      )}
      {total > 1 && !ro && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          <button
            title={t("chat.queueMoveUp")}
            aria-label="queueMoveUp"
            disabled={!canUp}
            onClick={() => doMove(-1)}
            style={{ ...iconBtn, cursor: canUp ? "pointer" : "default", opacity: canUp ? 1 : 0.3 }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            title={t("chat.queueMoveDown")}
            aria-label="queueMoveDown"
            disabled={!canDown}
            onClick={() => doMove(1)}
            style={{ ...iconBtn, cursor: canDown ? "pointer" : "default", opacity: canDown ? 1 : 0.3 }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </span>
      )}
      {kind === "follow-up" && canSteerOut && (
        <button
          title={t("chat.queueSteerSend")}
          aria-label="queueSteerSend"
          onClick={doSteerSend}
          style={{ ...iconBtn, color: "rgba(180,130,0,1)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(234,179,8,0.12)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      )}
      {kind === "steer" && !ro && (
        <button
          title={t("chat.queueToFollowUp")}
          aria-label="queueToFollowUp"
          onClick={doConvert}
          style={{ ...iconBtn, color: "rgba(129,140,248,1)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(129,140,248,0.14)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="8 3 4 7 8 11" />
            <polyline points="16 13 20 17 16 21" />
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="20" y1="17" x2="4" y2="17" />
          </svg>
        </button>
      )}
      {!ro && (
        <button
          title={t("chat.queueRecallOne")}
        aria-label="queueRecallOne"
        onClick={doRecall}
        style={iconBtn}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {/* 铅笔（square-pen）= 移回输入框编辑 */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
        </svg>
      </button>
      )}
      {!ro && (
        <button
          title={t("chat.queueRemove")}
          aria-label="queueRemoveOne"
        onClick={() => doRemove(false)}
        style={{ ...iconBtn, color: "var(--text-dim)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--danger, #ef4444)";
          e.currentTarget.style.background = "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-dim)";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
      )}
    </div>
  );
}

// t 来自 host-shim（module 顶部注入由 entry 设置 ctx；这里用运行时 ctx.t 兜底）

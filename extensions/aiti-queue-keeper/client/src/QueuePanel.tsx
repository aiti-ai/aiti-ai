/**
 * QueuePanel —— 队列面板主组件（aiti-queue-keeper 核心 UI）。
 *
 * 从 core ChatInput 横幅面板（L2796–3440 增强区）整体移植：折叠/展开横幅、
 * QueuedMessageRow 行列表、回收站弹层、撤销条、导入导出、通知。差异：
 * 全部状态（折叠/通知/回收站/撤销/拖拽）在本组件内部；操作统一经 props.actions
 * 原语调用；不依赖 core 的 useI18n/useIsMobile（t 经 host-shim，isMobile 由 props 传入）。
 *
 * 插槽渲染条件（core 负责）：bottomMode === "full" 时渲染本面板；队列/回收站
 * 为空时也渲染（保留「导入历史」入口 + 通知条）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueueRow } from "./QueueRow";
import type { QueuePanelProps, QueueTrashItem } from "./types";
import { t } from "./host-shim";
import { setPanelCommands } from "./panel-bus";

/** 软删撤销条窗口（ms）。 */
const UNDO_WINDOW = 8000;
/** 通知条窗口（ms）。 */
const NOTICE_WINDOW = 3000;

export function QueuePanel(props: QueuePanelProps) {
  const { live, trash, queueCount, trashCount, actions, isMobile } = props;
  const steering = live.steering ?? [];
  const followUp = live.followUp ?? [];

  // ── 折叠态（用户手动折叠优先，不自动隐藏）──
  const [queueCollapsedUser, setQueueCollapsedUser] = useState<boolean | null>(null);
  const queueCollapsed = queueCollapsedUser ?? false;
  const toggleQueueCollapsed = useCallback(() => {
    setQueueCollapsedUser((prev) => !(prev ?? false));
  }, []);

  // ── 通知条（导入/导出/回收站反馈；空队列也可见）──
  const [queueNotice, setQueueNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const queueNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showQueueNotice = useCallback((text: string, ok: boolean) => {
    setQueueNotice({ text, ok });
    if (queueNoticeTimerRef.current) clearTimeout(queueNoticeTimerRef.current);
    queueNoticeTimerRef.current = setTimeout(() => setQueueNotice(null), NOTICE_WINDOW);
  }, []);

  // ── 软删条目 + 撤销条 ──
  const [lastDeleted, setLastDeleted] = useState<(QueueTrashItem & { kind: "steer" | "followUp"; index: number }) | null>(null);
  const undoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 回收站弹层 ──
  const [trashOpen, setTrashOpen] = useState(false);
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [purgeAllConfirm, setPurgeAllConfirm] = useState(false);
  const trashButtonRef = useRef<HTMLButtonElement>(null);
  const trashPanelRef = useRef<HTMLDivElement>(null);

  const handleRemoveQueueItem = useCallback(async (
    kind: "steer" | "followUp",
    index: number,
    opts?: { permanent?: boolean },
  ) => {
    const removed = await actions.remove(kind, index, opts);
    if (removed && !opts?.permanent) {
      setLastDeleted({ ...removed, kind, index });
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      undoHideTimerRef.current = setTimeout(() => setLastDeleted(null), UNDO_WINDOW);
    }
    return removed;
  }, [actions]);

  const handleUndoDelete = useCallback(async () => {
    const item = lastDeleted;
    if (!item) return;
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    setLastDeleted(null);
    const ok = await actions.restore(item.id, item.index);
    if (!ok) {
      // Restore failed — put the toast back so the user can retry.
      setLastDeleted(item);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      undoHideTimerRef.current = setTimeout(() => setLastDeleted(null), UNDO_WINDOW);
    } else {
      setQueueCollapsedUser(null);
    }
  }, [lastDeleted, actions]);

  const handleRestoreTrashItem = useCallback(async (item: QueueTrashItem) => {
    // composer 条目（输入清除内容）→ 恢复到输入框继续编辑；队列条目照旧回队列
    const ok = item.kind === "composer"
      ? await actions.restoreToComposer(item.id)
      : await actions.restore(item.id);
    if (ok) {
      setLastDeleted((cur) => (cur && cur.id === item.id ? null : cur));
      setQueueCollapsedUser(null);
      showQueueNotice(t("chat.queueTrashRestored", { count: "1" }), true);
    }
  }, [actions, showQueueNotice]);

  const handleRestoreAllTrash = useCallback(async () => {
    // 全部恢复只处理队列条目（steer/followUp）；composer 条目恢复到输入框会覆盖
    // 正在编辑的内容，保持逐条恢复（最小惊讶）。
    const items = (trash ?? []).filter((item) => item.kind !== "composer");
    let ok = true;
    for (const item of items) {
      const r = await actions.restore(item.id);
      if (!r) ok = false;
    }
    if (ok && items.length > 0) {
      setLastDeleted(null);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      setQueueCollapsedUser(null);
      showQueueNotice(t("chat.queueTrashRestored", { count: String(items.length) }), true);
    }
  }, [actions, trash, showQueueNotice]);

  const handlePurgeTrashItem = useCallback(async (id: string) => {
    const ok = await actions.purge([id]);
    if (ok) {
      setLastDeleted((cur) => (cur && cur.id === id ? null : cur));
      showQueueNotice(t("chat.queueTrashPurged", { count: "1" }), true);
    }
    setPurgeConfirmId(null);
  }, [actions, showQueueNotice]);

  const handlePurgeAllTrash = useCallback(async () => {
    const count = trashCount;
    const ok = await actions.purge();
    if (ok) {
      setLastDeleted(null);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      showQueueNotice(t("chat.queueTrashPurged", { count: String(count) }), true);
      setTrashOpen(false);
    }
    setPurgeAllConfirm(false);
  }, [actions, trashCount, showQueueNotice]);

  const resetTrashConfirms = useCallback(() => {
    setPurgeConfirmId(null);
    setPurgeAllConfirm(false);
  }, []);

  // 回收站为空 → 自动收起弹层。
  useEffect(() => {
    if ((trash?.length ?? 0) === 0) {
      setTrashOpen(false);
      setPurgeConfirmId(null);
      setPurgeAllConfirm(false);
    }
  }, [trash]);

  // 点击面板外 → 关闭回收站弹层。
  useEffect(() => {
    if (!trashOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        trashOpen &&
        trashPanelRef.current && !trashPanelRef.current.contains(e.target as Node) &&
        trashButtonRef.current && !trashButtonRef.current.contains(e.target as Node)
      ) {
        setTrashOpen(false);
        resetTrashConfirms();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [trashOpen, resetTrashConfirms]);

  // 卸载时清定时器。
  useEffect(() => () => {
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    if (queueNoticeTimerRef.current) clearTimeout(queueNoticeTimerRef.current);
  }, []);

  // ── 拖拽排序（桌面 HTML5 / 移动触摸）──
  const dragFromRef = useRef<{ kind: "steer" | "followUp"; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<{ kind: "steer" | "followUp"; index: number } | null>(null);
  const handleDragStart = useCallback((kind: "steer" | "followUp", index: number) => {
    dragFromRef.current = { kind, index };
  }, []);
  const handleDragOver = useCallback((kind: "steer" | "followUp", index: number) => {
    setDragOverIndex({ kind, index });
  }, []);
  const handleDrop = useCallback((kind: "steer" | "followUp", targetIndex: number) => {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    setDragOverIndex(null);
    if (!from || from.kind !== kind || from.index === targetIndex) return;
    void actions.move(kind, from.index, targetIndex);
  }, [actions]);

  // ── 导入（隐藏 file input + parse/stage）──
  const queueImportFileRef = useRef<HTMLInputElement>(null);
  const onImportFile = useCallback(async (file: File) => {
    try {
      const entries = actions.parseImport(await file.text());
      if (entries.length === 0) {
        showQueueNotice(t("chat.queueImportEmpty"), false);
        return;
      }
      const staged = await actions.stageImport(entries);
      if (staged !== null && staged > 0) {
        showQueueNotice(t("chat.queueImported", { count: String(staged) }), true);
      }
    } catch {
      showQueueNotice(t("chat.queueImportEmpty"), false);
    }
  }, [actions, showQueueNotice]);
  // actions 边界拦截：行按钮等直接消费 actions.remove，统一改道本面板的
  // handleRemoveQueueItem（软删 → lastDeleted 撤销条）。其余原语原样透传。
  const panelActions = useMemo(() => ({
    ...actions,
    remove: handleRemoveQueueItem,
  }), [actions, handleRemoveQueueItem]);

  const handleExport = useCallback(async () => {
    const data = await actions.exportAll();
    if (!data) return;
    actions.downloadExport(data.live, { source: "live" }, "json");
    showQueueNotice(t("chat.queueExported", { count: String(queueCount) }), true);
  }, [actions, queueCount, showQueueNotice]);

  // 登记命令到 panel-bus（controller.expand/notice 经此转发；卸载时清除）。
  useEffect(() => {
    setPanelCommands({
      expand: () => setQueueCollapsedUser(null),
      notice: (text: string, ok: boolean) => showQueueNotice(text, ok),
    });
    return () => setPanelCommands(null);
  }, [showQueueNotice]);

  const hasAny = queueCount > 0 || (trash?.length ?? 0) > 0;

  // 空队列：QueuePanel 不渲染（返回 null）——导入入口回归 composerTools 底部控制行
  // （扩展注册的 QueueImportButton，与压缩/导入同排），不再孤零零浮在输入框上方。
  if (!hasAny) return null;

  return (
    <div style={{ position: "relative", marginBottom: 8, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: "5px 0" }}>
      <input
        ref={queueImportFileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onImportFile(file);
        }}
      />
      <div style={{
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "space-between",
        gap: isMobile ? 2 : 8,
        padding: isMobile ? "6px 10px 4px" : "2px 10px 2px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 24 }}>
          {queueCount > 0 && (
            <button
              onClick={toggleQueueCollapsed}
              title={queueCollapsed ? t("chat.queueExpand") : t("chat.queueCollapse")}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 6px", border: "none", background: "transparent",
                color: "var(--text-dim)", cursor: "pointer", borderRadius: 5,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform 0.12s", transform: queueCollapsed ? "rotate(-90deg)" : undefined, flexShrink: 0 }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span style={{ fontSize: 11.5, color: "var(--text-dim)", whiteSpace: "nowrap", lineHeight: 1 }}>
                {t("chat.queued", { count: String(queueCount) })}
              </span>
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: isMobile ? "nowrap" : "wrap", justifyContent: "flex-end", marginTop: isMobile ? 2 : 0 }}>
          {/* 小屏纯图标按钮（文字走 title/aria-label，防折行保单行）；编辑=铅笔（square-pen）*/}
          <button
            onClick={actions.recallAll}
            title={t("chat.recallTitle")}
            aria-label={t("chat.recall")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: isMobile ? "4px 7px" : "3px 10px", fontSize: 12,
              color: "var(--text)", background: "transparent", border: "1px solid var(--border)",
              borderRadius: 7, cursor: "pointer", transition: "background 0.12s, border-color 0.12s", whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
            </svg>
            {!isMobile && t("chat.recall")}
          </button>
          <button
            title={t("chat.queueExport")}
            aria-label={t("chat.queueExport")}
            onClick={() => void handleExport()}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: isMobile ? "4px 7px" : "3px 10px", fontSize: 12,
              color: "var(--text)", background: "transparent", border: "1px solid var(--border)",
              borderRadius: 7, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {!isMobile && t("chat.queueExport")}
          </button>
          <button
            title={t("chat.queueImport")}
            aria-label={t("chat.queueImport")}
            onClick={() => queueImportFileRef.current?.click()}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: isMobile ? "4px 7px" : "3px 10px", fontSize: 12,
              color: "var(--text)", background: "transparent", border: "1px solid var(--border)",
              borderRadius: 7, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {!isMobile && t("chat.queueImport")}
          </button>
          {(trash?.length ?? 0) > 0 && (
            <button
              ref={trashButtonRef}
              title={t("chat.queueTrashTitle")}
              onClick={() => { setTrashOpen((v) => !v); setPurgeConfirmId(null); setPurgeAllConfirm(false); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                padding: isMobile ? "4px 7px" : "3px 10px", fontSize: 12,
                color: trashOpen ? "var(--accent)" : "var(--text)",
                background: trashOpen ? "var(--bg-hover)" : "transparent",
                border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              {!isMobile && t("chat.queueTrash")}
              <span style={{
                fontSize: 10, color: "var(--text-muted)", background: "var(--bg-hover)",
                border: "1px solid var(--border)", padding: "0 6px", borderRadius: 999, lineHeight: "15px",
              }}>
                {trash?.length ?? 0}
              </span>
            </button>
          )}
        </div>
      </div>
      {queueCollapsed && queueCount > 0 && (
        <div
          onClick={toggleQueueCollapsed}
          title={t("chat.queueExpand")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleQueueCollapsed();
            }
          }}
          style={{
            display: "flex", alignItems: "center", gap: 6, margin: "0 6px 4px", padding: "3px 6px",
            borderRadius: 6, fontSize: 11.5, color: "var(--text-dim)", whiteSpace: "nowrap",
            overflow: "hidden", cursor: "pointer", transition: "background 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "";
            e.currentTarget.style.color = "var(--text-dim)";
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: "rotate(-90deg)" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
            {(steering?.[0]?.text ?? followUp?.[0]?.text ?? "")}
          </span>
          {queueCount > 1 && (
            <span style={{
              flexShrink: 0, fontSize: 10, color: "var(--text-muted)", background: "var(--bg-hover)",
              border: "1px solid var(--border)", padding: "0 6px", borderRadius: 999, lineHeight: "16px",
            }}>
              +{queueCount - 1}
            </span>
          )}
          {!(steering?.[0]) && followUp?.[0] && actions.steerSend && (
            <button
              aria-label="queueSteerSendFirst"
              title={t("chat.queueSteerSend")}
              onClick={(e) => {
                e.stopPropagation();
                actions.steerSend?.(followUp[0].text, followUp[0].images);
                void handleRemoveQueueItem("followUp", 0, { permanent: true });
              }}
              style={{
                flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, border: "none", borderRadius: 5,
                background: "transparent", color: "rgba(180,130,0,1)", cursor: "pointer",
              }}
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
        </div>
      )}
      {!queueCollapsed && (
        <>
          {steering.map((entry) => (
            <QueueRow
              key={`steer-${entry.index}`}
              kind="steer"
              text={entry.text}
              images={entry.images}
              hasImages={entry.hasImages}
              hasFiles={entry.hasFiles}
              index={entry.index}
              total={steering.length}
              actions={panelActions}
              steerReadonly={props.steerReadonly === true}
              onDragStart={props.steerReadonly === true ? undefined : (idx) => handleDragStart("steer", idx)}
              onDragOver={props.steerReadonly === true ? undefined : (idx) => handleDragOver("steer", idx)}
              onDrop={props.steerReadonly === true ? undefined : (idx) => handleDrop("steer", idx)}
              onTouchMoveTo={props.steerReadonly === true ? undefined : (to) => void actions.move("steer", entry.index, to)}
              dragging={dragOverIndex?.kind === "steer" && dragOverIndex.index === entry.index}
              isCoarsePointer={props.isCoarsePointer}
            />
          ))}
          {followUp.map((entry) => (
            <QueueRow
              key={`followup-${entry.index}`}
              kind="follow-up"
              text={entry.text}
              images={entry.images}
              hasImages={entry.hasImages}
              hasFiles={entry.hasFiles}
              index={entry.index}
              total={followUp.length}
              actions={panelActions}
              onDragStart={(idx) => handleDragStart("followUp", idx)}
              onDragOver={(idx) => handleDragOver("followUp", idx)}
              onDrop={(idx) => handleDrop("followUp", idx)}
              onTouchMoveTo={(to) => void actions.move("followUp", entry.index, to)}
              dragging={dragOverIndex?.kind === "followUp" && dragOverIndex.index === entry.index}
              isCoarsePointer={props.isCoarsePointer}
            />
          ))}
        </>
      )}
      {lastDeleted && !trashOpen && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 8, zIndex: 55,
          display: "flex", alignItems: "center", gap: 8, maxWidth: "calc(100% - 16px)",
          padding: "5px 8px 5px 10px", background: "var(--bg-panel)",
          border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
          borderRadius: 7, boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
          fontSize: 11.5, color: "var(--text)",
        }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
            {t("chat.queueUndoDeleted")}{lastDeleted.text ? `: ${lastDeleted.text}` : ""}
          </span>
          <button
            onClick={() => void handleUndoDelete()}
            title={t("chat.queueUndoTitle")}
            style={{
              flexShrink: 0, border: "none", background: "transparent", color: "var(--accent)",
              cursor: "pointer", fontSize: 11.5, fontWeight: 600, padding: "2px 6px", borderRadius: 5,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            {t("chat.queueUndo")}
          </button>
        </div>
      )}
      {trashOpen && (
        <div ref={trashPanelRef} style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 8, width: "min(430px, calc(100% - 16px))",
          zIndex: 50, background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "0 10px 30px rgba(0,0,0,0.35)", padding: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 6px" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)", flex: 1 }}>
              {t("chat.queueTrashCount", { count: String(trash?.length ?? 0) })}
            </span>
            <button
              onClick={() => { setTrashOpen(false); resetTrashConfirms(); }}
              title={t("chat.close")}
              style={{ border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", padding: 2, display: "flex", borderRadius: 4 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          {(trash?.length ?? 0) === 0 ? (
            <div style={{ padding: "14px 6px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
              {t("chat.queueTrashEmpty")}
            </div>
          ) : (
            <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {(trash ?? []).map((item) => (
                <div
                  key={item.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 6, background: "transparent" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{
                    flexShrink: 0, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.4,
                    color: "var(--text-muted)", background: "var(--bg-hover)", border: "1px solid var(--border)",
                    borderRadius: 4, padding: "0 5px", lineHeight: "16px",
                  }}>
                    {item.kind === "steer" ? t("chat.queueRecoveryKindSteer") : item.kind === "composer" ? t("chat.queueTrashFromInput") : t("chat.queueRecoveryKindFollowUp")}
                  </span>
                  <span
                    title={item.text || t("chat.queueRecoveryNoText")}
                    style={{ flex: 1, fontSize: 11.5, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {item.text || t("chat.queueRecoveryNoText")}
                    {item.hasImages && <span style={{ color: "var(--text-dim)", marginLeft: 4, display: "inline-flex" }}><svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></span>}
                  </span>
                  <button
                    title={item.kind === "composer" ? t("chat.queueTrashRestoreToInput") : t("chat.queueTrashRestore")}
                    onClick={() => void handleRestoreTrashItem(item)}
                    style={{
                      flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4,
                      border: "1px solid var(--border)", background: "transparent", color: "var(--text)",
                      borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                    {item.kind === "composer" ? t("chat.queueTrashRestoreToInput") : t("chat.queueTrashRestore")}
                  </button>
                  {purgeConfirmId === item.id ? (
                    <button
                      onClick={() => void handlePurgeTrashItem(item.id)}
                      style={{
                        flexShrink: 0, border: "1px solid var(--danger, #ef4444)", background: "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)",
                        color: "var(--danger, #ef4444)", borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap",
                      }}
                    >
                      {t("chat.confirm")}
                    </button>
                  ) : (
                    <button
                      title={t("chat.queueTrashPurge")}
                      onClick={() => {
                        setPurgeConfirmId(item.id);
                        setTimeout(() => setPurgeConfirmId((cur) => (cur === item.id ? null : cur)), 3000);
                      }}
                      style={{
                        flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                        width: 24, height: 24, border: "none", background: "transparent",
                        color: "var(--text-dim)", borderRadius: 5, cursor: "pointer",
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
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", paddingTop: 6, borderTop: "1px solid var(--border)", marginTop: 6 }}>
            <button
              onClick={() => void handleRestoreAllTrash()}
              disabled={(trash?.length ?? 0) === 0}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                border: "1px solid var(--border)", background: "transparent", color: "var(--text)",
                borderRadius: 6, padding: "3px 10px", fontSize: 11.5,
                cursor: (trash?.length ?? 0) === 0 ? "default" : "pointer",
                opacity: (trash?.length ?? 0) === 0 ? 0.5 : 1, whiteSpace: "nowrap",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 14 4 9 9 4" />
                <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
              </svg>
              {t("chat.queueTrashRestoreAll")}
            </button>
            {purgeAllConfirm ? (
              <button
                onClick={() => void handlePurgeAllTrash()}
                style={{
                  border: "1px solid var(--danger, #ef4444)", background: "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)", color: "var(--danger, #ef4444)",
                  borderRadius: 6, padding: "3px 10px", fontSize: 11.5, cursor: "pointer", whiteSpace: "nowrap",
                }}
              >
                {t("chat.queueTrashPurgeAllConfirm")}
              </button>
            ) : (
              <button
                onClick={() => {
                  setPurgeAllConfirm(true);
                  setTimeout(() => setPurgeAllConfirm(false), 3000);
                }}
                disabled={(trash?.length ?? 0) === 0}
                title={t("chat.queueTrashPurgeAll")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)",
                  borderRadius: 6, padding: "3px 10px", fontSize: 11.5,
                  cursor: (trash?.length ?? 0) === 0 ? "default" : "pointer",
                  opacity: (trash?.length ?? 0) === 0 ? 0.5 : 1, whiteSpace: "nowrap",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                {t("chat.queueTrashPurgeAll")}
              </button>
            )}
          </div>
        </div>
      )}
      {/* 通知条（导入/导出/回收站反馈；空队列也可见，置于面板下方） */}
      {queueNotice && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11,
            color: queueNotice.ok ? "#16a34a" : "var(--danger, #ef4444)", whiteSpace: "nowrap",
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              {queueNotice.ok
                ? <><polyline points="20 6 9 17 4 12" /></>
                : <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
            </svg>
            {queueNotice.text}
          </span>
        </div>
      )}
    </div>
  );
}
/* hash-detection-test 1794028498 */

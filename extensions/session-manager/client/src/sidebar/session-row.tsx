/**
 * sidebar/session-row —— 会话行组件（宿主 SessionSidebar SessionTreeItem/SessionItem 完整复制）。
 *
 * 交互 1:1：hover 显示重命名/删除按钮、行内改名输入、删除行内确认（同高）、
 * 子会话缩进线 + subagent/fork 图标、折叠切换、运行中转圈/未读波点、
 * agent 徽标、worktree 分支标、草稿徽标、右键菜单事件、行内三个扩展点
 * （sessionRowLeading/sessionRowMeta/sessionRowActions 经宿主 renderSlot 渲染）。
 *
 * [+ 2026-09-09] hover 区新增「⋮」菜单（仅 dock 用；宿主原生左栏不经此文件）：
 * buildLivePiRowMenuItems 全量项（重命名/生成名字/移动到…/相关文档/时间线），
 * 与 All Sessions 行菜单同源（row-menu.tsx）；宿主 RowMenuHost 挂 entry dialogs。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, t, getExtProvides, renderSlot } from "../host-shim";
import { formatRelativeTime, skillExpansionToCommand, SESSION_LIST_ITEM_HEIGHT, type SessionInfo, type SessionTreeNode } from "./pure";
import { RunningSessionIndicator, UnreadSessionIndicator, RunOutcomeIndicator, dispatchSessionRowContextMenu } from "./parts";
// 薄壳拆分（§5.1）：row-menu/move-dialog 在懒 chunk——行「⋮」点击时才 import（点开
// 一次后浏览器模块缓存，后续零延迟）。buildLivePiRowMenuItems/openRowMenu/showMoveDialog
// 均从已加载模块调用。
const menuChunk = () => Promise.all([import("../row-menu"), import("../move-dialog")]);
import { markPendingRemoval, clearPendingRemoval, isPendingRemoval, subscribePendingRemovals, applySessionNameLocal } from "../store";

export interface SessionTreeItemProps {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  isDraft?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  locale: string;
  /** 置顶（固定 tag「📌 置顶」承载，dock 传入；未传 = 不显示置顶入口） */
  isPinned?: boolean;
  onTogglePin?: () => void;
}

export function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  isDraft,
  collapsed,
  onToggleCollapse,
  locale,
  isPinned,
  onTogglePin,
}: SessionTreeItemProps) {
  const hasChildren = node.children.length > 0;

  return (
    <div style={{ position: "relative" }}>
      {/* Indent line for child sessions */}
      {depth > 0 && (
        <div style={{
          position: "absolute",
          left: depth * 12 + 6,
          top: 0, bottom: 0,
          width: 1,
          background: "var(--border)",
          pointerEvents: "none",
        }} />
      )}
      <SessionItem
        session={node.session}
        isSelected={node.session.id === selectedSessionId}
        isRunning={runningSessionIds.has(node.session.id)}
        isUnread={unreadSessionIds.has(node.session.id)}
        onClick={() => onSelectSession(node.session)}
        onRenamed={onRenamed}
        onDeleted={(id) => onSessionDeleted?.(id)}
        depth={depth}
        isDraft={isDraft}
        hasChildren={hasChildren}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        locale={locale}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
      />
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  isDraft,
  locale,
  isPinned = false,
  onTogglePin,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isDraft?: boolean;
  locale: string;
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  // 能力接管：有扩展声明 session-delete 时隐藏内置删除入口（与宿主同语义）。
  const extOwnsDelete = getExtProvides().has("session-delete");
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 行移除进行中（面板归档/删除/从列表移除 → 左栏行同步置灰 + 禁点）：模块级 Map
  // 变更不触发本组件 store 订阅，单独订阅驱动重渲染
  const [, setRemovalTick] = useState(0);
  useEffect(() => subscribePendingRemovals(() => setRemovalTick((v) => v + 1)), []);
  // 本行正在移除：自身 deleting 或扩展级 pending（面板触发时同步置灰左栏行）
  const removing = deleting || isPendingRemoval(session.id, "live");

  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(session.id)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return; // 失败（TUI bridge 占用 409 等）→ 保留旧名
      applySessionNameLocal(session.id, name); // 就地更新 store：UI 立即反映，不等列表刷新往返
      onRenamed?.(); // 后台对齐（节流合流；服务端 rev 指纹含 name，下次 patch/全量自然同步）
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    // 行移除进行中置灰（与 All Sessions 面板同源 pendingRemovals：后台刷新慢，让用户知道在动）
    markPendingRemoval(session.id, "live");
    try {
      await fetch(apiUrl(`/api/sessions/${encodeURIComponent(session.id)}`), { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      clearPendingRemoval(session.id);
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: { shiftKey: boolean; stopPropagation: () => void }) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleContextMenu = useCallback((e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      onClick={confirmDelete || renaming || removing ? undefined : onClick}
      onContextMenu={confirmDelete || renaming || removing ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming || removing ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid var(--danger, #ef4444)"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: removing ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "var(--danger, #ef4444)", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* 行前部扩展点：扩展渲染常驻状态图标（如 aiti-plan-first 方案绑定标） */}
          {renderSlot("sessionRowLeading", { currentSession: session as never })}
          {/* Child session indicator — subagent=机器人，fork=分支 */}
          {depth > 0 && (session.relation?.kind === "subagent" ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          ))}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
              {/* 置顶徽标（📌 固定 tag；dock 传入 isPinned 才渲染） */}
              {isPinned && (
                <span
                  title={t("sm.pinned") ?? "已置顶"}
                  style={{ flexShrink: 0, fontSize: 9, lineHeight: 1.5 }}
                >📌</span>
              )}
              {/* 移除进行中标注（面板归档/删除/从列表移除 → 左栏同步，后台刷新慢） */}
              {removing && (
                <span
                  title={t("sm.pendingRemoval") ?? "正在移除…"}
                  style={{
                    flexShrink: 0,
                    fontSize: 9,
                    fontStyle: "italic",
                    color: "var(--text-dim)",
                    whiteSpace: "nowrap",
                  }}
                >
                  ⟳ {t("sm.pendingRemoval") ?? "处理中…"}
                </span>
              )}
              {isDraft && (
                <span
                  title={t("sidebar.draftTitle")}
                  style={{
                    flexShrink: 0,
                    fontSize: 9,
                    fontWeight: 600,
                    fontStyle: "italic",
                    color: "var(--text-dim)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    padding: "0 4px",
                    lineHeight: 1.5,
                  }}
                >
                  {t("sidebar.draft")}
                </span>
              )}
              {session.agent && (
                <span
                  title={`Backend: ${session.agent}`}
                  style={{
                    flexShrink: 0,
                    fontSize: 9,
                    fontWeight: 600,
                    color: "#a78bfa",
                    border: "1px solid #a78bfa66",
                    borderRadius: 4,
                    padding: "0 4px",
                    lineHeight: 1.5,
                  }}
                >
                  {session.agent}
                </span>
              )}
            </div>
            <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {isRunning && <RunningSessionIndicator />}
              {!isRunning && isUnread && <UnreadSessionIndicator />}
              {/* 运行终态异常标记（failed/aborted/interrupted；completed 不显示） */}
              {!isRunning && session.lastRun && session.lastRun.status !== "completed" && (
                <RunOutcomeIndicator run={session.lastRun} />
              )}
              <span title={session.modified}>{formatRelativeTime(session.modified, locale)}</span>
              <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
              {/* 行内 meta 扩展点（转圈/消息数所在第二行末尾）：如 aiti-plan-first 方案绑定标 + front-matter tags */}
              {renderSlot("sessionRowMeta", { currentSession: session as never })}
              {session.isWorktree && session.branch && (
                <span
                  title={`Worktree: ${session.cwd}`}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.branch}</span>
                </span>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(
                collapsed
                  ? (session.relation?.kind === "subagent" ? "sidebar.expandSubagents" : "sidebar.expandBranches")
                  : (session.relation?.kind === "subagent" ? "sidebar.collapseSubagents" : "sidebar.collapseBranches"),
              )}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover (hidden for unsaved drafts); 移除进行中不显示（行已禁点） */}
          {hovered && !isDraft && !removing && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {renderSlot("sessionRowActions", { currentSession: session as never })}
              {/* 「⋮」全量行菜单（与 All Sessions 行菜单同源，row-menu.tsx；长显于菜单展开面不接 feature）：
                  重命名 = 行内改名（同铅笔）；生成名字/移动 = 模块级实现；相关文档/时间线 = 公开弹层通道 */}
              <button
                data-row-menu-trigger="1"
                title={t("sm.more") ?? "更多操作"}
                onClick={(e) => {
                  e.stopPropagation();
                  // 同步捕获触发元素：React 合成事件在 handler 返回后会把 currentTarget 置 null，
                  // 动态 import 的异步回调里再访问 e.currentTarget 会拿到 null（getBoundingClientRect 崩溃）。
                  const trigger = e.currentTarget;
                  void menuChunk().then(([rm, md]) => {
                    rm.openRowMenu(rm.buildLivePiRowMenuItems({
                      sess: session,
                      running: !!isRunning,
                      startRename: () => startRename({ stopPropagation() {} }),
                      onMove: () => md.showMoveDialog(session),
                      pin: onTogglePin ? { pinned: !!isPinned, onToggle: onTogglePin } : undefined,
                    }), trigger);
                  });
                }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  fontSize: 15, fontWeight: 700, lineHeight: 1,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >⋮</button>
              {/* 重命名铅笔已省——「⋮」菜单第一项即重命名（行内改名同一 startRename），避免双入口重复 */}
              {!extOwnsDelete && (
                <button
                  onClick={handleDeleteClick}
                  title={t("sidebar.deleteWithShiftClick")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32, padding: 0,
                    background: "var(--bg-hover)", border: "1px solid var(--border)",
                    borderRadius: 7, color: "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0,
                    transition: "background 0.12s, color 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                    e.currentTarget.style.color = "var(--danger, #ef4444)";
                    e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text-muted)";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

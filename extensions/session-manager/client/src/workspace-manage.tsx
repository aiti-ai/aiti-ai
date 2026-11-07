/**
 * session-manager · 管理工作区列表（CWD picker 下拉底部 workspacePickerActions 插槽）。
 *
 * 侧边栏项目下拉本身只读（列表由 getRecentProjects 从会话派生，无法直接删）。
 * 本组件接管该插槽：
 *  - 「⚙ 管理」按钮 → 管理弹窗
 *  - 每项操作：选择（切到该项目）/ 隐藏显示（localStorage 持久化，核心消费过滤）/
 *    「删除」→ 确认后二选一：把全部会话移动 cwd 到新位置（move-batch）或归档全部（archive/run）。
 *
 * 隐藏列表契约与核心 lib/workspace-hide.ts 一致（localStorage key + 变更事件），
 * 两端硬编码同字符串——核心 SessionSidebar 监听事件即时重过滤。
 */

import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { t, apiUrl } from "./host-shim";
import { store, useStore, displayCwd, moveBatchSession, archiveBatchSession, markPendingRemoval, clearPendingRemoval, ensureTags, togglePinProject, movePinnedProject, unpinProject } from "./store";
import { orderProjects, pinnedProjectKeys } from "./sidebar/pure";
import { ghostBtn, miniBtn, ensureReadability } from "./helpers";
import { MoveCwdPicker } from "./move-cwd-picker";

/** 与核心 lib/workspace-hide.ts 共享的隐藏列表契约（两端硬编码同一字符串）。 */
const HIDDEN_KEY = "pi-web:hidden-workspaces";
const WS_CHANGED_EVENT = "pi-web:workspaces-changed";

function loadHidden(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

/** 写隐藏列表并通知核心（侧栏下拉即时重过滤；跨 tab 靠 storage 事件）。 */
function saveHidden(roots: readonly string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set(roots)]));
  } catch { /* best effort */ }
  try { window.dispatchEvent(new Event(WS_CHANGED_EVENT)); } catch { /* non-DOM */ }
}

/** 该项目下的 live pi 会话（归档记录/外部 agent 会话不算——move/archive 只作用于 live）。 */
function sessionsInProject(root: string): any[] {
  return (store.sessions as any[]).filter((s) => !s.archived && !s.agent && (s.projectRoot ?? s.cwd) === root);
}

const overlayStyle: Record<string, string | number> = {
  position: "fixed", inset: 0, zIndex: 293, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center",
};

export interface WorkspaceManageProps {
  projects: { key: string; root: string }[];
  allProjects: { key: string; root: string }[];
  selectedCwd: string | null;
  hiddenWorkspaces: ReadonlySet<string>;
  onSelect: (root: string) => void;
  onClose: () => void;
}

/** CWD picker 下拉底部的「⚙ 管理」入口。 */
export function WorkspaceManageEntry(props: WorkspaceManageProps) {
  const [open, setOpen] = useState(false);
  const s = useStore(); // 订阅会话列表（删除/移动/归档后计数即时刷新）
  void s;
  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        style={{
          display: "flex", alignItems: "center", gap: 7,
          width: "100%", padding: "8px 10px", background: "none", border: "none",
          color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11,
        }}
        title={t("sm.manageWorkspacesTitle")}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {t("sm.manageWorkspaces")}
      </button>
    );
  }
  return <ManageDialog {...props} onCloseDialog={() => setOpen(false)} />;
}

/** 弹窗本体（薄壳拆分后由 entry 触发按钮经懒 chunk 挂载）。 */
export function ManageDialog(props: WorkspaceManageProps & { onCloseDialog: () => void }) {
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden());
  const [deleting, setDeleting] = useState<{ root: string; key: string; sessions: any[] } | null>(null);
  const [moving, setMoving] = useState<{ root: string; target: string; busy: boolean } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinning, setPinning] = useState(false);
  const s = useStore(); // 钉住态在 tagData 里（服务端共享）：act/actPut 后 emit → 列表即时重排
  void s;

  // 钉住判断依赖 tagData（面板直开、侧栏未挂载时也要能显示 📌 态）
  useEffect(() => { void ensureTags(); }, []);

  // 外部（核心或其他 tab）改了隐藏列表 → 同步
  useEffect(() => {
    const onChg = () => setHidden(loadHidden());
    window.addEventListener(WS_CHANGED_EVENT, onChg);
    window.addEventListener("storage", onChg);
    return () => {
      window.removeEventListener(WS_CHANGED_EVENT, onChg);
      window.removeEventListener("storage", onChg);
    };
  }, []);

  // 钉住段在前（与侧栏下拉同序）；↑↓ 边界按「呈现出来的钉段」算，幽灵键自动排除
  const pinnedKeys = pinnedProjectKeys(store.tagData);
  const listed = orderProjects(props.allProjects, pinnedKeys);
  const listedPinned = listed.filter((p) => pinnedKeys.includes(p.key));

  const withPinBusy = (fn: () => Promise<unknown>) => async () => {
    if (pinning) return;
    setPinning(true);
    try { await fn(); } finally { setPinning(false); }
  };

  const toggleHidden = (root: string) => {
    const next = new Set(hidden);
    if (next.has(root)) next.delete(root); else next.add(root);
    setHidden(next);
    saveHidden([...next]);
  };

  const confirmDelete = (root: string, key: string) => {
    const sessions = sessionsInProject(root);
    setDeleting({ root, key, sessions });
  };

  const doMove = async () => {
    if (!deleting || !moving || busy) return;
    setBusy(true);
    const res = await moveBatchSession(deleting.sessions.map((x) => x.id), moving.target);
    setBusy(false);
    if (res.ok) await unpinProject(deleting.key); // 项目已搬空 → 顺带清钉
    window.alert?.(
      res.ok
        ? t("sm.manageMoved", { moved: res.movedCount, skipped: res.skippedCount })
        : `${t("sm.manageMoveFailed") ?? "移动失败"}：${res.error ?? ""}`,
    );
    setDeleting(null); setMoving(null);
  };

  const doArchive = async () => {
    if (!deleting || busy) return;
    const ids = deleting.sessions.map((x) => x.id);
    // 先置灰涉及的会话行（后台刷新慢，让用户知道在动），失败恢复样式
    for (const id of ids) markPendingRemoval(id, "live");
    setBusy(true); setArchiving(true);
    const res = await archiveBatchSession(ids);
    if (!res.ok) for (const id of ids) clearPendingRemoval(id);
    else await unpinProject(deleting.key); // 项目已无在册会话 → 顺带清钉
    setBusy(false); setArchiving(false);
    window.alert?.(
      res.ok
        ? t("sm.manageArchived", { archived: res.archived }) + (res.skipped ? `（${res.skipped} 个运行中/打开中已跳过）` : "")
        : t("sm.manageArchiveFailed"),
    );
    setDeleting(null);
  };

  const close = () => { if (!busy) props.onCloseDialog(); };

  // overlay 一律 portal 到 body：管理弹窗渲染在 CWD picker 下拉（AnimatedDropdown）
  // 内部，其 slide 动画的 transform 祖先会创建 containing block 困住 position:fixed
  // 子元素（下拉关闭后 transform 已移除，但动画期间~200ms 内仍被困）——portal 彻底
  // 脱离该祖先链，fixed 恒相对视口。aiti-float（data-ext-float）按面板自身 DOM 接管，
  // 不受 portal 影响；真模态框保留 data-ext-float-keepmask（点外关闭随之失效）。
  return createPortal(
    <div style={overlayStyle} onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-w={560} data-ext-float-h={560} data-ext-float-full="1"
        style={{
          width: "min(560px, 94vw)", maxHeight: "min(620px, 84vh)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
          overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        {/* 标题栏（首子元素 = aiti-float 拖拽把手） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px 8px" }}>
          <strong style={{ fontSize: 13, flex: 1 }}>{t("sm.manageWorkspaces")}</strong>
          <button onClick={close} disabled={busy} aria-label={t("sm.close") ?? "关闭"} title={t("sm.close") ?? "关闭"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "0 16px 8px", lineHeight: 1.5 }}>
          {t("sm.manageWorkspacesHint")}
        </div>

        {/* 项目列表 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px 8px" }}>
          {props.allProjects.length === 0 && (
            <div style={{ padding: "16px 10px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
              {t("sm.manageNoWorkspaces")}
            </div>
          )}
          {listed.map((p) => {
            const isHidden = hidden.has(p.root);
            const isSelected = p.root === props.selectedCwd;
            const sessionCount = sessionsInProject(p.root).length;
            const isPinned = pinnedKeys.includes(p.key);
            const pinAt = listedPinned.findIndex((x) => x.key === p.key);
            return (
              <div
                key={p.key}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 8px", borderRadius: 8,
                  background: isSelected ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
                  border: isSelected ? "1px solid rgba(37,99,235,0.35)" : "1px solid transparent",
                  marginBottom: 4,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                </svg>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontFamily: "var(--font-mono)", color: isHidden ? "var(--text-dim)" : "var(--text)", textDecoration: isHidden ? "line-through" : "none" }}>
                  {displayCwd(p.root)}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{sessionCount} ↵</span>
                {isHidden && (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, background: "var(--bg)", padding: "1px 5px", borderRadius: 5 }}>{t("sm.manageHidden")}</span>
                )}
                <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
                  <button type="button" disabled={pinning}
                    onClick={withPinBusy(() => togglePinProject(p.key))}
                    style={{ ...(miniBtn as React.CSSProperties), color: isPinned ? "var(--accent)" : "var(--text-dim)" }}
                    title={isPinned ? t("sm.unpinProject") : t("sm.pinProject")}>📌</button>
                  {isPinned && (
                    <>
                      <button type="button" disabled={pinning || pinAt <= 0}
                        onClick={withPinBusy(() => movePinnedProject(p.key, -1))}
                        style={miniBtn as React.CSSProperties} title={t("sm.projectPinUp")}>↑</button>
                      <button type="button" disabled={pinning || pinAt >= listedPinned.length - 1}
                        onClick={withPinBusy(() => movePinnedProject(p.key, 1))}
                        style={miniBtn as React.CSSProperties} title={t("sm.projectPinDown")}>↓</button>
                    </>
                  )}
                  {!isSelected && (
                    <button type="button" onClick={() => { props.onSelect(p.root); props.onCloseDialog(); }}
                      style={miniBtn as React.CSSProperties} title={t("sm.manageSelect")}>{t("sm.manageSelect")}</button>
                  )}
                  <button type="button" onClick={() => toggleHidden(p.root)}
                    style={{ ...(miniBtn as React.CSSProperties), color: isHidden ? "var(--accent)" : "var(--text-dim)" }} title={t("sm.manageHide")}>
                    {isHidden ? (t("sm.manageShow") ?? "显示") : (t("sm.manageHide") ?? "隐藏")}
                  </button>
                  <button type="button" onClick={() => confirmDelete(p.root, p.key)}
                    style={{ ...(miniBtn as React.CSSProperties), color: "var(--danger, #f87171)" }} title={t("sm.manageDelete")}>
                    🗑
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ padding: "8px 16px 12px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={close} disabled={busy} style={ghostBtn as React.CSSProperties}>{t("sm.close") ?? "关闭"}</button>
        </div>
      </div>

      {/* 删除确认：归档全部 或 移动全部到新位置 */}
      {deleting && createPortal(
        <div style={overlayStyle}>
          <div
            onClick={(e) => e.stopPropagation()}
            data-ext-float="1" data-ext-float-w={460} data-ext-float-h={280} data-ext-float-keepmask="1"
            style={{
              width: "min(460px, 92vw)", display: "flex", flexDirection: "column",
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
              overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)", padding: 16,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              🗑 {t("sm.manageDeleteTitle")}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayCwd(deleting.root)} · {t("sm.manageDeleteCount", { count: deleting.sessions.length })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                onClick={() => setMoving({ root: deleting.root, target: "", busy: false })}
                disabled={busy || deleting.sessions.length === 0}
                style={{ ...(ghostBtn as React.CSSProperties), textAlign: "left", color: "var(--text)", lineHeight: 1.5 }}
              >
                📁 {t("sm.manageMoveAll")}
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{t("sm.manageMoveAllHint")}</div>
              </button>
              <button
                type="button"
                onClick={() => void doArchive()}
                disabled={busy || deleting.sessions.length === 0}
                style={{ ...(ghostBtn as React.CSSProperties), textAlign: "left", color: "var(--text)", lineHeight: 1.5 }}
              >
                {archiving ? "…" : "🗜 "}{t("sm.manageArchiveAll")}
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{t("sm.manageArchiveAllHint")}</div>
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button onClick={() => { if (!busy) { setDeleting(null); setMoving(null); } }} disabled={busy} style={ghostBtn as React.CSSProperties}>{t("sm.close") ?? "关闭"}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 移动目标输入 */}
      {moving && createPortal(
        <div style={overlayStyle}>
          <div
            onClick={(e) => e.stopPropagation()}
            data-ext-float="1" data-ext-float-w={460} data-ext-float-h={300} data-ext-float-keepmask="1"
            style={{
              width: "min(460px, 92vw)", display: "flex", flexDirection: "column",
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
              overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)", padding: 16,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              📁 {t("sm.moveTitle") ?? "移动会话"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
              {t("sm.manageDeleteCount", { count: deleting?.sessions.length ?? 0 })}
            </div>
            <label style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
              {t("sm.moveTarget") ?? "目标目录（cwd）"}
            </label>
            <MoveCwdPicker
              value={moving.target}
              onChange={(root) => setMoving({ ...moving, target: root })}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button onClick={() => setMoving(null)} disabled={busy} style={ghostBtn as React.CSSProperties}>{t("sm.close") ?? "关闭"}</button>
              <button
                onClick={() => void doMove()}
                disabled={busy || !moving.target.trim()}
                style={{ ...(ghostBtn as React.CSSProperties), color: ensureReadability("var(--ok, #22c55e)"), borderColor: "#22c55e66" } as React.CSSProperties}
              >{busy ? "…" : `${t("sm.moveConfirm") ?? "移动"}`}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>,
    document.body,
  );
}

export const WorkspaceManageEntryMemo = WorkspaceManageEntry;

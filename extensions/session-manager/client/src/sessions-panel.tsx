/**
 * session-manager · 全部会话面板（SessionsPanel）+ 归档会话查看器（ArchivedViewer）。
 * 自手写版迁移，交互/性能优化点（T-1 双帧挂载 / T-2 淡入动画 / content-visibility）一比一保留。
 */
import { useState, useEffect, useRef, useLayoutEffect } from "react"
import type { ReactNode } from "react";
import { t, apiUrl, openFile } from "./host-shim";
import {
  store, useStore, panelOpen, managerOpen, refreshSessions, refreshListChannels, ensureTags, collapsePanelIfCovering,
  archiveSession, restoreSession, deleteArchivedSession, act, notifySessionsChanged, hideExtSession,
  sharedFilter, clearSharedFilter, useSharedFilter, toggleSharedFilter, setPendingSearch, consumePendingSearch,
  displayCwd, EMPTY_TAGS, moveSession, deleteLiveSession, detectSessionCwd,
  refreshSources, sourceAction, importSession, openLiveSession, useAgentFilter, toggleAgentFilter,
  fetchRelatedDocs, subscribeRunningFrames,
  markPendingRemoval, clearPendingRemoval, isPendingRemoval, subscribePendingRemovals,
  applySessionNameLocal, collectSubtreeIds,
  SM_PANEL_KEY, ARCHIVED_VIEWER_KEY, EXT_VIEWER_KEY, openExtViewer, openViewer, closeViewer, closeExtViewer,
  viewerSessionId, subscribeViewerSession, extViewerId, subscribeExtViewer,
} from "./store";
import {
  fmtRelative, byIdMap, tagPath, sessionTagIds, matchesTags, sessionTitle, highlight,
  getDatePresets, dateFilterMatches, roleBadge, descendantsLocal,
  inputStyle, ghostBtn, miniBtn, agentBadge, AGENT_META, ensureReadability, SIc,
} from "./helpers";
import { StarButton, TagEditPopover, TagChip } from "./tag-ui";
import { ArchiveMenu } from "./archive-menu";
import { showConfirm } from "./confirm-dialog";
import { showRelatedDocs } from "./related-docs";
// 行「⋮」菜单共享件（MenuItem/触发/宿主/活动 pi 会话全量项构建）——与 SidebarDock 左栏行同源
import { RowMenu, closeRowMenu, openSessionTimeline, buildLivePiRowMenuItems, type MenuItem } from "./row-menu";
import { showToast } from "./toast";
// 移动会话弹窗模块态宿主（showMoveDialog 触发；Esc 守卫用 useMoveDialogOpen）
import { showMoveDialog, useMoveDialogOpen } from "./move-dialog";
// dock v3（P3 批）：显隐收口展示状态机 + 右栏停靠 face
import { useGate, usePresent, DockBody, openFloat, closePanel } from "../../../_shared/ext-float-dock";
import { ViewerMessages } from "./viewer-messages";
// 跨扩展复用（构建期内联，见 entry.tsx 说明）：aiti-folder 的 workspace 切换弹窗
//（已知 workspace 优先列表 + 过滤 + 自定义路径兜底 DirectoryBrowser）。
import { WorkspaceDropdown } from "../../../aiti-folder/client/src/folder-switcher";
import { MoveCwdPicker } from "./move-cwd-picker";
import { truncateRunErrorText } from "./sidebar/pure";

const PAGE_SIZE = 20;

/** 目录过滤匹配：cwd 是否精确等于所选目录（root）—— 只匹配该目录本身的会话，
 * 不包含其子目录（如选 ~/workspace 不覆盖 ~/workspace/aiti-ai）；兼容 \\ 与 / 。 */
const normDir = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
const underRoot = (cwd: string | undefined, root: string) =>
  !!cwd && !!root && normDir(cwd) === normDir(root);

/*
 * 行内「⋯」更多菜单（收藏/标签以外的低频操作收进来，行上只留高频的 ★ 和标签弹层）：
 * MenuItem / RowMenu（触发）/ RowMenuHost（常驻弹层）已抽至 row-menu.tsx —— 与
 * SidebarDock 左栏行同源共用；宿主改挂 entry.tsx dialogs slot（全局一次，固定定位 +
 * z 2147483500 高于 aiti-float 抬升上限，不再依赖面板 overlay 抬升）。
 */

/**
 * 批量移动对话框：共享一个默认目标位置 + 逐会话展示（当前 cwd + 检测到的真实 cwd），
 * 每行可独立改目标覆盖默认值。全部移动时逐会话调用 /move（sessionId 不变，历史/收藏/标签保留）；
 * 运行中/外部 agent 会话标记跳过。
 */
function BatchMoveDialog(props: { ids: string[]; allSessions: any[]; onDone: () => void; onClose: () => void }) {
  const [defaultCwd, setDefaultCwd] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [detected, setDetected] = useState<Record<string, { current: string; candidates: Array<{ root: string; count: number }> }>>({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<string | null>(null);
  // 行会话：只取 live pi 会话（外部 agent/归档记录不适用 move，标记跳过）
  const rows = props.ids.map((id) => props.allSessions.find((x) => x.id === id)).filter(Boolean);
  const movables = rows.filter((s: any) => !s.agent && !s.archived);

  // 逐会话识别真实 cwd（串行限流）
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const s of movables) {
        if (!alive) return;
        const r = await detectSessionCwd(s.id);
        if (alive && r) setDetected((prev) => ({ ...prev, [s.id]: { current: r.current, candidates: r.candidates } }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cwdOf = (s: any) => overrides[s.id] || defaultCwd || s.cwd || "";
  const submit = async () => {
    const target = (defaultCwd || "").trim();
    if (!target || busy) return;
    setBusy(true); setResults(null);
    const moved: string[] = []; const errs: string[] = [];
    for (const s of movables) {
      // overrides 为空串/未设 → 回落到默认目标 target（submit 已保证 target 非空，故 t 不会为空）；
      // 防御性保留空判：万一为空则跳过该行（不再计 skipped——真正的 skip 是「不可移动」那些）。
      const t = (overrides[s.id] || target).trim();
      if (!t) continue;
      const err = await moveSession(s.id, t);
      if (err) errs.push(`${sessionTitle(s)}: ${err}`); else moved.push(s.id);
    }
    setBusy(false);
    // 跳过 = 不可移动（外部 agent / 归档），即未进入 movables 的那部分
    const skippedCount = rows.length - movables.length;
    let msg = t("sm.moveBatchDone", { count: moved.length }) ?? `已移动 ${moved.length} 个会话`;
    if (skippedCount > 0) msg += ` · ${t("sm.moveBatchSkip", { n: skippedCount }) ?? `${skippedCount} 个会话不可移动已跳过`}`;
    if (errs.length) msg += ` · ${errs.length} 失败`;
    setResults(msg);
    setTimeout(() => { if (moved.length) props.onDone(); else if (!errs.length) props.onClose(); }, 600);
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 294, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (!busy) props.onClose(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-w={520} data-ext-float-h={420} data-ext-float-full="1"
        style={{
          width: "min(520px, 94vw)", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
          overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 4px" }}>
          <strong style={{ fontSize: 13, flex: 1, display: "flex", alignItems: "center", gap: 6 }}><SIc name="folder" size={13} />{t("sm.moveBatch") ?? "批量移动会话"}</strong>
          <button onClick={() => { if (!busy) props.onClose(); }} disabled={busy} title={t("sm.close") ?? "关闭"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ padding: "4px 14px 8px", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("sm.moveBatchHint") ?? "设置默认目标位置；每行可单独改目标覆盖默认值。运行中的会话会被跳过。"}</div>
        <div style={{ padding: "4px 14px 8px" }}>
          <label style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>{t("sm.moveBatchDefault") ?? "默认目标位置（cwd）"}</label>
          <MoveCwdPicker value={defaultCwd} onChange={setDefaultCwd} />
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px 8px" }}>
          {movables.map((s: any) => {
            const det = detected[s.id];
            const target = cwdOf(s);
            const isFallback = !overrides[s.id] && !defaultCwd;
            return (
              <div key={s.id} style={{ marginBottom: 6, padding: "4px 6px", borderRadius: 8, background: "var(--bg-hover)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionTitle(s)}</span>
                  {det?.current && <span style={{ fontSize: 9, color: "var(--text-dim)", flexShrink: 0 }}>{t("sm.cur") ?? "当前"}:{displayCwd(det.current)}</span>}
                </div>
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 3 }}>
                  {det?.candidates && det.candidates.length > 0 && (
                    <button type="button" onClick={() => setOverrides((p) => ({ ...p, [s.id]: det.candidates![0].root }))}
                      title={det.candidates[0].root} style={{ ...miniBtn, fontSize: 9, color: "var(--accent)", maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties}>
                      {t("sm.detect") ?? "检测"}:{displayCwd(det.candidates[0].root)}
                    </button>
                  )}
                  <input value={target} onChange={(e) => setOverrides((p) => ({ ...p, [s.id]: e.target.value }))}
                    placeholder={isFallback ? "（用默认目标）" : target}
                    style={{ ...(inputStyle as React.CSSProperties), flex: 1, fontSize: 10, fontFamily: "var(--font-mono)" }}
                  />
                </div>
              </div>
            );
          })}
          {rows.length > movables.length && (
            <div style={{ padding: "6px 8px", fontSize: 10, color: "var(--text-dim)" }}>{t("sm.moveBatchSkip") ?? `${rows.length - movables.length} 个会话不可移动（外部 agent/归档）已跳过`}</div>
          )}
        </div>
        {results && <div style={{ padding: "4px 14px 8px", fontSize: 11, color: ensureReadability("var(--ok, #22c55e)") }}>{results}</div>}
        <div style={{ padding: "8px 14px 12px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => { if (!busy) props.onClose(); }} disabled={busy} style={ghostBtn}>{t("sm.close") ?? "关闭"}</button>
          <button onClick={() => void submit()} disabled={busy || !defaultCwd.trim()} style={{ ...ghostBtn, color: ensureReadability("var(--ok, #22c55e)"), borderColor: "#22c55e66" } as React.CSSProperties}>{busy ? "…" : `${t("sm.moveConfirm") ?? "移动"}`}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Archive dialog: 4 options (resolved / unresolved / direct / delete) ── */
function ArchiveDialog(props: { ids: string[]; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isSingle = props.ids.length === 1;

  const run = async (mode: "resolved" | "unresolved" | "direct" | "delete") => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === "delete") {
        // 直接删除（未归档）：与归档是两个独立功能——不经过归档直接删会话文件
        // 自绘确认弹窗（替换浏览器原生 confirm）；失败错误显示在确认弹窗内
        showConfirm({
          title: t("sm.deleteTitle") ?? "彻底删除",
          message: isSingle
            ? (t("sm.confirmDeleteLive") ?? "彻底删除该会话文件？删后不可恢复；运行中的 agent 会先停止。")
            : (t("sm.batchDeleteMsg", { count: props.ids.length }) ?? `永久删除 ${props.ids.length} 个未归档会话，不可恢复；运行中会先停止。`),
          confirmLabel: t("sm.archiveDelete") ?? "彻底删除",
          danger: true,
          onConfirm: async () => {
            // 确认后才开始：先置灰全部目标行（后台刷新慢，让用户知道在动），失败恢复
            for (const id of props.ids) markPendingRemoval(id, "live");
            try {
              for (const id of props.ids) {
                const e = await deleteLiveSession(id);
                if (e) {
                  clearPendingRemoval(id);
                  throw new Error(`${t("sm.deleteFailed") ?? "删除失败"}：${e}`);
                }
              }
              props.onClose();
            } catch (err) {
              // 后续未执行到的行同样恢复（避免残留置灰）；已成功删除的行等刷新落地 prune 清
              for (const id of props.ids) clearPendingRemoval(id);
              throw err;
            }
          },
        });
        return;
      }
      // 归档（含已解决/未解决 tag 前置）：执行即置灰全部目标行，失败逐行恢复
      for (const id of props.ids) markPendingRemoval(id, "live");
      const fail = () => { for (const id of props.ids) clearPendingRemoval(id); };
      for (const id of props.ids) {
        if (mode === "resolved" || mode === "unresolved") {
          // 归档前先打 tag（多语名称；不存在则自动创建，默认颜色：已完成=绿 / 未完成=灰）
          const tagPath = mode === "resolved" ? t("sm.archiveTagResolved") : t("sm.archiveTagUnresolved");
          const ok = await act("assign", { sessionId: id, path: tagPath });
          if (!ok) { fail(); setErr(`${id.slice(0, 8)} tag 失败`); return; }
        }
        // ext 源行（zcode/cursor 等只读镜像）不进归档管线：默默改走视图层移除（源数据不动）
        const row = store.sessions?.find((r) => String(r.id) === id) as { agent?: string } | undefined;
        if (row?.agent && row.agent !== "pi") {
          const ok = await hideExtSession(id, true);
          if (!ok) { fail(); setErr(`${id.slice(0, 8)} 移除失败`); return; }
          continue;
        }
        const ok = await archiveSession(id);
        if (!ok) { fail(); setErr(`${id.slice(0, 8)} 归档失败`); return; }
      }
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const btn = (mode: "resolved" | "unresolved" | "direct" | "delete", icon: ReactNode, label: string, color: string) => (
    <button
      key={mode}
      onClick={() => void run(mode)}
      disabled={busy}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        width: "100%", padding: "10px 14px", textAlign: "left",
        background: "var(--bg-hover)", border: `1px solid ${color}33`,
        borderRadius: 8, cursor: busy ? "default" : "pointer", fontSize: 13,
        color: "var(--text)", opacity: busy ? 0.6 : 1,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", color }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontSize: 10, color, fontWeight: 700 }}>{busy ? "…" : "›"}</span>
    </button>
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 293, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-w={420} data-ext-float-h={300} data-ext-float-full="1"
        style={{
          width: "min(420px, 94vw)", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
          overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)", padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: 14, flex: 1 }}>{t("sm.archiveDialogTitle") ?? "归档会话"}</strong>
          <button onClick={props.onClose} disabled={busy} aria-label={t("sm.close") ?? "关闭"} title={t("sm.close") ?? "关闭"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
          {isSingle ? props.ids[0].slice(0, 12) : `${props.ids.length} ${t("sm.selectedCount", { count: props.ids.length }) ?? "个会话"}`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {btn("resolved", <SIc name="checkCircle" size={15} />, t("sm.archiveResolved") ?? "已解决归档", ensureReadability("var(--ok, #22c55e)"))}
          {btn("unresolved", <SIc name="helpCircle" size={15} />, t("sm.archiveUnresolved") ?? "未解决归档", ensureReadability("#64748b"))}
          {btn("direct", <SIc name="archive" size={15} />, t("sm.archiveDirect") ?? "直接归档", ensureReadability("var(--warn, #f59e0b)"))}
          {btn("delete", <SIc name="trash" size={15} />, t("sm.archiveDelete") ?? "直接删除", ensureReadability("var(--danger, #f87171)"))}
        </div>
        {err && (
          <div style={{ marginTop: 10, padding: "6px 10px", borderRadius: 6, background: "rgba(239,68,68,0.08)", color: ensureReadability("var(--danger, #f87171)"), fontSize: 11 }}>{err}</div>
        )}
      </div>
    </div>
  );
}

/* ── M1: external session viewer (read-only + import-to-pi) ──
 * dock v3（P3 批）：显隐收口展示状态机；id 状态机已收编 store.ts（薄壳拆分 §5.1，
 * kanban/entry 的 openExtViewer 不依赖本懒 chunk）。 */

/**
 * Read-only viewer for external (non-pi) sessions: shows the normalized
 * message stream + a primary "import as pi session" button (§4.5).
 */
export function ExtViewer(props: any) { return renderExtViewer(props, "float"); }
export function ExtViewerDockFace(props: any) { return renderExtViewer(props, "dock"); }

function renderExtViewer(props: any, face?: string) {
  const st = usePresent(EXT_VIEWER_KEY);
  const [id, setId] = useState<string | null>(extViewerId());
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  useEffect(() => subscribeExtViewer(() => setId(extViewerId())), []);
  useEffect(() => {
    if (!id) { setData(null); setErr(null); return; }
    let alive = true;
    fetch(apiUrl(`/api/extensions/session-manager/session-ext?id=${encodeURIComponent(id)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [id]);

  if (!id) return null;
  if (face === "float" ? st !== "floating" : st !== "docked:right-panel") return null;
  const close = closeExtViewer;
  const openPi = (newId: string) => {
    closeExtViewer();
    const piSession = (store.sessions as any[]).find((x) => x.id === newId)
      ?? { id: newId, cwd: data?.meta?.cwd ?? "", name: `[${data?.agent}] ${(data?.meta?.firstMessage ?? "").slice(0, 40)}` };
    props.onSelectSession?.(piSession);
    collapsePanelIfCovering();
  };
  const doImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const newId = await importSession(id);
      if (newId) openPi(newId);
      else window.alert?.(t("sm.import.failed"));
    } finally {
      setImporting(false);
    }
  };
  const doOpenLive = async () => {
    if (opening || !id) return;
    setOpening(true);
    setOpenErr(null);
    try {
      const result = await openLiveSession(id, data?.meta?.cwd ?? undefined);
      if (result.ok) {
        closeExtViewer();
        // 合成 SessionInfo 切主聊天窗：loadSession 对未知 id 走 404 空态，
        // SSE/命令经 handle adapter 打到 live 后端。
        props.onSelectSession?.({
          id: result.sessionId,
          path: "",
          cwd: data?.meta?.cwd ?? "",
          name: data?.meta?.name ?? data?.label ?? id,
          created: data?.meta?.created ?? new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: data?.messages?.length ?? 0,
          firstMessage: data?.meta?.firstMessage ?? "",
          transient: true,
        });
        collapsePanelIfCovering();
      } else {
        setOpenErr(
          result.reason === "no_provider"
            ? `未安装能驱动该 agent 的后端扩展（agentKey 见会话徽标；如 aiti-claude-code-agent）`
            : `打开失败：${result.error ?? result.reason}`,
        );
      }
    } finally {
      setOpening(false);
    }
  };
  const badge = agentBadge(data?.agent);

  const viewerBoxStyle: React.CSSProperties = face === "float"
    ? { width: "min(720px, 94vw)", height: "min(80vh, 720px)", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)" }
    : { width: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--text)", overflow: "hidden" };
  const viewerInner = (<>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <ViewerTitle
            prefix={badge}
            name={data?.meta?.name}
            firstMessage={data?.meta?.firstMessage}
            fallback={data?.label ?? t("sm.viewer.extSession")}
            subParts={[data?.label, data?.meta?.cwd, fmtDay(data?.meta?.created), data?.messages ? t("sm.msgCount", { count: data.messages.length }) : null]}
          />
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
            <button disabled={opening} onClick={() => void doOpenLive()} title="通过后端扩展接管此会话（需安装对应 ati-*-agent 扩展）" style={{ ...ghostBtn, color: ensureReadability("#a78bfa"), borderColor: "#a78bfa66" } as React.CSSProperties}>
              {opening ? "…" : "打开(接管)"}
            </button>
            {data?.importedSessionId ? (
              <button onClick={() => openPi(data.importedSessionId)} style={{ ...ghostBtn, color: ensureReadability("var(--ok, #22c55e)"), borderColor: "#22c55e66" } as React.CSSProperties}>
                ✓ 已导入 ↗ 打开
              </button>
            ) : (
              <button disabled={importing} onClick={() => void doImport()} style={{ ...ghostBtn, color: ensureReadability("var(--ok, #22c55e)"), borderColor: "#22c55e66" } as React.CSSProperties}>
                {importing ? t("sm.sources.loading") : t("sm.import.button")}
              </button>
            )}
            {face === "float" && <button onClick={close} aria-label={t("sm.close")} title={t("sm.close")}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 } as React.CSSProperties}>✕</button>}
          </span>
        </div>
        {openErr && (
          <div style={{ padding: "6px 12px", background: "rgba(239,68,68,0.08)", borderBottom: "1px solid var(--border)", color: ensureReadability("var(--danger, #f87171)"), fontSize: 11 }}>
            {openErr}
          </div>
        )}
        {err ? <div style={{ padding: 20, color: ensureReadability("var(--danger, #f87171)"), fontSize: 12 }}>{err}</div>
          : !data ? <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12 }}>{t("sm.loading") ?? "…"}</div>
          : <ViewerMessages key={id} messages={data.messages} agent={data?.agent} />}
    </>
  );
  // dock v3 分面：float = 遮罩+浮窗壳；dock = 右栏 tab（DockBody chrome 带 ⇲/位置菜单，TabBar ✕ 关闭）
  if (face === "dock") {
    return (
      <DockBody itemKey={EXT_VIEWER_KEY} zone="right-panel" title={t("sm.viewer.extSession")} chrome="tab"
        zones={["right-panel"]} defaultZone="right-panel">
        <div onClick={(e) => e.stopPropagation()} style={viewerBoxStyle}>{viewerInner}</div>
      </DockBody>
    );
  }
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={close}
    >
      <div onClick={(e) => e.stopPropagation()} className="sm-viewer-float" data-ext-float="1" data-ext-float-key={EXT_VIEWER_KEY} data-ext-float-dock="right-panel" data-ext-float-dock-default="right-panel" data-ext-float-w={720} data-ext-float-h={620} data-ext-float-full="1"
        style={viewerBoxStyle}>
        {viewerInner}
      </div>
    </div>
  );
}

/* ── 弹窗消息区（归档/外部查看器共用）：聊天式布局，见 ./viewer-messages.tsx ── */

/**
 * 查看器头部两行式信息（归档/外部共用）：
 *   第一行：前缀（📦 / agent 徽标）+ 会话名 ‖ 首条用户消息（截 60）
 *   第二行：小字 sid/agent label · cwd · 创建日期 · N 条
 */
function ViewerTitle(props: { prefix: any; name?: string; firstMessage?: string; fallback: string; subParts: Array<string | undefined | null> }) {
  const raw = (props.name || props.firstMessage || "").trim().replace(/\s+/g, " ");
  const title = raw ? (raw.length > 60 ? raw.slice(0, 60) + "…" : raw) : props.fallback;
  const sub = props.subParts.filter((x): x is string => !!x).join(" · ");
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {props.prefix}
        <strong title={raw || undefined} style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{title}</strong>
      </div>
      {sub && <div title={sub} style={{ fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

const fmtDay = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try { return d.toLocaleDateString(); } catch { return iso.slice(0, 10); }
};

/**
 * 弹窗顶部「本会话操作过的文件」strip：服务端从 toolCall 块提取（read/edit/write）。
 * chip = 文件名（title 全路径），点击经宿主 ctx.openFile 在主窗文件查看器打开。
 */
function FilesStrip(props: { files: string[] }) {
  const files = props.files;
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return null;
  const COLLAPSED = 10;
  const shown = expanded ? files : files.slice(0, COLLAPSED);
  const basename = (p: string) => p.split("/").pop() || p;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0, marginRight: 2, display: "flex" }}><SIc name="fileText" size={11} /></span>
      {shown.map((p) => (
        <button
          key={p}
          title={`${p}（点击打开）`}
          onClick={() => openFile(p, basename(p))}
          style={{
            maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontSize: 10, padding: "2px 8px", borderRadius: 999, cursor: "pointer",
            background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)",
          }}
        >{basename(p)}</button>
      ))}
      {files.length > COLLAPSED && (
        <button
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "收起" : `共 ${files.length} 个文件`}
          style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 999, cursor: "pointer",
            background: "none", border: "1px dashed var(--border)", color: "var(--text-muted)",
          }}
        >{expanded ? "⌃" : `…+${files.length - COLLAPSED}`}</button>
      )}
    </div>
  );
}

/* ── archived session viewer (read-only) ──
 * viewerState/openViewer/closeViewer 已收编 store.ts（薄壳拆分 §5.1）。 */

/**
 * ArchivedViewer 操作：恢复（回到 live）/ 重开（恢复并直接打开）/ 彻底删除。
 * 供工具条按钮用；restore 成功后会话已回到 live，查看器随之关闭。
 */
function viewerAction(
  kind: "restore" | "reopen" | "delete",
  sessionId: string,
  data: any,
  props: any,
  setBusy?: (v: string | null) => void,
): Promise<void> {
  if (kind === "delete") {
    showConfirm({
      title: t("sm.deleteArchive") ?? "彻底删除",
      message: t("sm.confirmDeleteArchive") ?? "彻底删除该已归档会话？先归档才能删除，删后不可恢复。",
      confirmLabel: t("sm.archiveDelete") ?? "彻底删除",
      danger: true,
      onConfirm: () => {
        setBusy?.("delete");
        // 确认后置灰归档行（后台刷新慢），失败恢复样式
        markPendingRemoval(sessionId, "archived");
        return deleteArchivedSession(sessionId)
          .then((ok) => {
            if (!ok) { clearPendingRemoval(sessionId); window.alert?.(`${t("sm.deleteFailed") ?? "删除失败"}：${sessionId.slice(0, 8)}`); return; }
            closeViewer();
          })
          .finally(() => setBusy?.(null));
      },
    });
    return Promise.resolve();
  }
  // 恢复/重开：把行移出归档视图 —— 先置灰，失败恢复样式
  markPendingRemoval(sessionId, "archived");
  return restoreSession(sessionId).then((ok) => {
    if (!ok) {
      clearPendingRemoval(sessionId);
      window.alert?.(`${t(kind === "reopen" ? "sm.reopenFailed" : "sm.restoreFailed") ?? "操作失败"}：${sessionId.slice(0, 8)}`);
      return;
    }
    closeViewer();
    if (kind === "reopen") {
      const row = data?.session ?? {};
      // ext 视图层归档行：恢复后直接走后端扩展接管（⚡ 同链路），回活会话
      if (row.archiveRef === "__ext__") {
        void openLiveSession(sessionId, row.cwd ?? data?.meta?.cwd ?? "").then((r) => {
          if (r.ok) {
            props?.onSelectSession?.({
              id: r.sessionId,
              cwd: row.cwd ?? data?.meta?.cwd ?? "",
              name: row.name ?? undefined,
              created: row.created,
              modified: row.modified,
              messageCount: row.messageCount ?? 0,
              firstMessage: row.firstMessage ?? "",
              transient: true,
            });
          }
        });
        return;
      }
      props?.onSelectSession?.({
        id: sessionId,
        cwd: row.cwd ?? data?.meta?.cwd ?? "",
        name: row.name ?? undefined,
        created: row.created,
        modified: row.modified,
        messageCount: row.messageCount ?? 0,
        firstMessage: row.firstMessage ?? "",
      });
      collapsePanelIfCovering();
    }
  });
}

/** 归档会话相关文档 strip（v2 迭代，§9）：打开查看器即见该会话触达的 md，
 *  不再藏在工具条 📄 文档 弹层后（与 doc-center「点会话即见文档」能力对齐）。
 *  数据：fetchRelatedDocs → session-manager /related-docs → doc-center
 *  services.docs.docsOfSession（归档不改 sid，doc_sessions 历史关联照常命中）。
 *  降级：doc-center 缺席 / 无关联 → 不渲染。 */
function RelatedDocsStrip(props: { sessionId: string }) {
  const [docs, setDocs] = useState<any[] | null>(null);
  useEffect(() => {
    let alive = true;
    setDocs(null);
    fetchRelatedDocs(props.sessionId).then((r) => {
      if (alive) setDocs(r.available ? r.docs : []);
    });
    return () => { alive = false; };
  }, [props.sessionId]);
  if (!docs || !docs.length) return null;
  const basename = (p: string) => p.split("/").pop() || p;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0, marginRight: 2 }} title={t("sm.relatedDocs") ?? "相关文档"}>{"📚"}</span>
      {docs.slice(0, 12).map((d: any) => {
        const abs = String(d.root || "").replace(/\/+$/, "") + "/" + String(d.relpath || "");
        return (
          <button
            key={String(d.id ?? abs)}
            title={`${abs}（点击打开）`}
            onClick={() => openFile(abs, d.title || basename(String(d.relpath || "")))}
            style={{
              maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              fontSize: 10, padding: "2px 8px", borderRadius: 999, cursor: "pointer",
              background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-muted)",
            }}
          >{d.title || basename(String(d.relpath || ""))}</button>
        );
      })}
      {docs.length > 12 ? <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>…+{docs.length - 12}</span> : null}
    </div>
  );
}

export function ArchivedViewer(props: any) { return renderArchivedViewer(props, "float"); }
export function ArchivedViewerDockFace(props: any) { return renderArchivedViewer(props, "dock"); }

function renderArchivedViewer(props: any, face?: string) {
  const st = usePresent(ARCHIVED_VIEWER_KEY);
  const [sessionId, setSessionId] = useState<string | null>(viewerSessionId());
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actBusy, setActBusy] = useState<string | null>(null);
  useEffect(() => subscribeViewerSession(() => setSessionId(viewerSessionId())), []);
  useEffect(() => {
    if (!sessionId) { setData(null); setErr(null); return; }
    let alive = true;
    fetch(apiUrl(`/api/extensions/session-manager/archive/session/${sessionId}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [sessionId]);

  if (!sessionId) return null;
  if (face === "float" ? st !== "floating" : st !== "docked:right-panel") return null;
  const close = () => closeViewer();
  const archBoxStyle: React.CSSProperties = face === "float"
    ? {
        width: "min(720px, 94vw)", height: "min(80vh, 720px)", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden",
        boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
      }
    : { width: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-panel)", color: "var(--text)", overflow: "hidden" };
  const archInner = (<>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <ViewerTitle
            prefix={<><span style={{ flexShrink: 0 }}>📦</span>{agentBadge(data?.session?.agent)}</>}
            name={data?.session?.name ?? data?.meta?.name}
            firstMessage={(() => { const f = data?.meta?.firstMessage ?? data?.session?.firstMessage ?? ""; return f === "(no messages)" ? "" : f; })()}
            fallback={sessionId.slice(0, 8)}
            subParts={[sessionId.slice(0, 8), data?.meta?.cwd ?? data?.session?.cwd, fmtDay(data?.meta?.created ?? data?.session?.created), data?.messages ? t("sm.msgCount", { count: data.messages.length }) : null]}
          />
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
            {/* 重开：恢复回 live 并直接打开（对话区接管）；恢复：仅回到 live；彻底删除：确认后删归档记录 */}
            <button
              disabled={!!actBusy}
              onClick={() => { setActBusy("reopen"); void viewerAction("reopen", sessionId, data, props).finally(() => setActBusy(null)); }}
              title={t("sm.reopen") ?? "重开（恢复并打开）"}
              style={{ ...ghostBtn, color: ensureReadability("var(--ok, #22c55e)"), borderColor: "#22c55e66", opacity: actBusy && actBusy !== "reopen" ? 0.5 : 1 } as React.CSSProperties}
            >{actBusy === "reopen" ? "…" : `${t("sm.reopenShort") ?? "重开"}`}</button>
            <button
              disabled={!!actBusy}
              onClick={() => { setActBusy("restore"); void viewerAction("restore", sessionId, data, props).finally(() => setActBusy(null)); }}
              title={t("sm.restore") ?? "恢复为普通会话"}
              style={{ ...ghostBtn, color: ensureReadability("#a78bfa"), borderColor: "#a78bfa66", opacity: actBusy && actBusy !== "restore" ? 0.5 : 1 } as React.CSSProperties}
            >{actBusy === "restore" ? "…" : `↩️ ${t("sm.restoreShort") ?? "恢复"}`}</button>
            {data?.session?.archiveRef !== "__ext__" && (
              <button
                disabled={!!actBusy}
                onClick={() => void viewerAction("delete", sessionId, data, props, setActBusy)}
                title={t("sm.archiveDelete") ?? "彻底删除"}
                style={{ ...ghostBtn, color: ensureReadability("var(--danger, #f87171)"), borderColor: "#f8717166", opacity: actBusy && actBusy !== "delete" ? 0.5 : 1 } as React.CSSProperties}
              >{actBusy === "delete" ? "…" : `${t("sm.archiveDelete") ?? "彻底删除"}`}</button>
            )}
            <button
              onClick={() => showRelatedDocs(sessionId, String(data?.meta?.cwd ?? "").split("/").pop() || sessionId.slice(0, 8))}
              title={t("sm.relatedDocs") ?? "相关文档"}
              style={{ ...ghostBtn } as React.CSSProperties}
            >{`${t("sm.relatedDocsShort") ?? "文档"}`}</button>
            {data?.session?.archiveRef !== "__ext__" && (
              <>
                <a
                  href={apiUrl(`/api/extensions/session-manager/archive/export/${sessionId}?format=jsonl`)}
                  style={{ ...ghostBtn, textDecoration: "none", display: "inline-block" } as React.CSSProperties}
                >jsonl</a>
                <a
                  href={apiUrl(`/api/extensions/session-manager/archive/export/${sessionId}?format=md`)}
                  style={{ ...ghostBtn, textDecoration: "none", display: "inline-block" } as React.CSSProperties}
                >md</a>
              </>
            )}
            {face === "float" && <button onClick={close} aria-label={t("sm.close")} title={t("sm.close")}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 } as React.CSSProperties}>✕</button>}
          </span>
        </div>
        {err ? <div style={{ padding: 20, color: ensureReadability("var(--danger, #f87171)"), fontSize: 12 }}>{err}</div>
          : !data ? <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12 }}>{t("sm.empty")}</div>
          : <>
              {data.files?.length ? <FilesStrip files={data.files} /> : null}
              <RelatedDocsStrip sessionId={sessionId} />
              <ViewerMessages key={sessionId} messages={data.messages} agent={data?.session?.agent} />
            </>}
    </>
  );
  // dock v3 分面：float = 遮罩+浮窗壳；dock = 右栏 tab
  if (face === "dock") {
    return (
      <DockBody itemKey={ARCHIVED_VIEWER_KEY} zone="right-panel" title="归档查看器" chrome="tab"
        zones={["right-panel"]} defaultZone="right-panel">
        <div onClick={(e) => e.stopPropagation()} style={archBoxStyle}>{archInner}</div>
      </DockBody>
    );
  }
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sm-viewer-float"
        data-ext-float="1" data-ext-float-key={ARCHIVED_VIEWER_KEY} data-ext-float-dock="right-panel"
        data-ext-float-dock-default="right-panel" data-ext-float-w={720} data-ext-float-h={620} data-ext-float-full="1"
        style={archBoxStyle}
      >
        {archInner}
      </div>
    </div>
  );
}

export function SessionsPanel(props: any) {
  const s = useStore();
  // dock 双 face：挂载即开（浮窗/嵌入的显隐由 entry.tsx 的 useGate 门控，flag 不再驱动渲染）；
  // embedded=true：渲染为 DockBody 内的全尺寸嵌入块（不带 data-ext-float，float scan 不增强）
  const open = true;
  const embedded = !!props.embedded;
  // 面板关闭时清掉「⋮」菜单模块态（宿主已上提 entry dialogs 全局一次；面板关闭后菜单不应残留）
  // 不清会在下次打开时残留上次的展开项）。gate 卸载即 unmount，此处恒 open 无需清理触发。
  useEffect(() => { if (!open) closeRowMenu(); }, [open]);

  // T-1: defer the list content to the frame AFTER the overlay/frame appears.
  // Opening mounts a full section tree (favorites + running + a page of rows)
  // in one shot, which forces one big layout. Splitting it into two frames —
  // overlay+header first, rows one frame later — keeps the open interaction
  // responsive and halves the per-frame layout work.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!open) { setReady(false); return; }
    let raf1 = 0, raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setReady(true));
    });
    return () => { if (raf1) cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); };
  }, [open]);

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [debounced, setDebounced] = useState("");
  const [searchHits, setSearchHits] = useState<any[] | null>(null); // null = not searching
  const [rowBusy, setRowBusy] = useState(new Set<string>());
  const [archStatus, setArchStatus] = useState<any>(null);
  const [archBusy, setArchBusy] = useState(false);
  const markBusy = (id: string) => setRowBusy((prev) => new Set(prev).add(id));
  const markDone = (id: string) => setRowBusy((prev) => { const n = new Set(prev); n.delete(id); return n; });
  const isBusy = (id: string) => rowBusy.has(id);
  // 行移除操作进行中（归档/删除/从列表移除）置灰订阅：模块级 Map 变更不触发 store.emit，
  // 单独订阅驱动重渲染（行内 isPendingRemoval 读最新值）
  const [, setPendingTick] = useState(0);
  useEffect(() => subscribePendingRemovals(() => setPendingTick((v) => v + 1)), []);
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  // §14.2 filter menu + §14.3 stats drawer + §14.4 batch/rename
  const [filterOpen, setFilterOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [datePreset, setDatePreset] = useState("");
  const [cwdFilter, setCwdFilter] = useState(""); // 目录过滤（aiti-folder DirectoryBrowser 选择）
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  // 移动会话弹窗模块态订阅（showMoveDialog 触发；Esc 守卫用）
  const moveOpen = useMoveDialogOpen();
  const [sortBy, setSortBy] = useState("modified");
  const [sortAsc, setSortAsc] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [selection, setSelection] = useState(new Set<string>());
  const [batchBusy, setBatchBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [batchMoveOpen, setBatchMoveOpen] = useState(false); // 批量移动对话框开关
  const [archiveDialogIds, setArchiveDialogIds] = useState<string[] | null>(null); // 归档对话框目标（null=关闭）
  const [expandedTags, setExpandedTags] = useState(new Set<string>());
  /* §4 section collapse — persisted so a long favorites list stays folded across reopens/reloads */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("sm.collapsedSections") ?? "[]")); }
    catch { return new Set(); }
  });
  const toggleSection = (key: string) => setCollapsedSections((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    try { localStorage.setItem("sm.collapsedSections", JSON.stringify([...next])); } catch {}
    return next;
  });
  const selectedTags = useSharedFilter(); // shared with topbar chips (§3.4)
  const agentFilter = useAgentFilter(); // 默认只选 pi（§4.7 反馈：外部源默认不显示）
  const searchRef = useRef<HTMLInputElement>(null);

  // 小屏（data-ext-float-full 触发：≤640px 宽）下把「标签云 + agent 云 +
  // 外部源条 + 会话列表」合并成一个滚动容器（整窗一个滚动位置），并在向下滚动时
  // 把标签云/agent 云各自收拢到 2 行，紧凑展示会话；滚回顶部自动展开。大屏不启用。
  const [scrunch, setScrunch] = useState<"full" | "brief" | "expanded">("full");
  const [compact, setCompact] = useState(false);
  const scrunchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => { setCompact(mq.matches); setScrunch("full"); };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  // 滚动方向：向下滚动（内容上移，scrollTop 增大）→ 收拢到 2 行；滚回顶部 → 自动展开。
  useEffect(() => {
    if (!compact || !open) return;
    const el = scrunchRef.current;
    if (!el) return;
    const onScroll = () => {
      const st = el.scrollTop;
      if (st > 60) {
        // 向下滚过阈值：若手动展开过则保持 expanded，否则收拢
        setScrunch((prev) => (prev === "expanded" ? prev : "brief"));
      } else if (st < 8) {
        setScrunch("full");
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [compact, open]);
  // 顶栏搜索框：每次提交（含面板已打开状态）把查询词注入面板 + 聚焦搜索框；
  // 面板关闭时也注册（返回 null 的组件 hooks 仍生效），打开后查询词即生效。
  useEffect(() => {
    const l = () => {
      const q = consumePendingSearch();
      if (q) {
        setQuery(q);
        setPage(0);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    panelOpen.subs.add(l);
    return () => { panelOpen.subs.delete(l); };
  }, []);
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(query); setPage(0); }, 150);
    return () => clearTimeout(id);
  }, [query]);

  const cwdMenuRef = useRef<HTMLSpanElement>(null);
  // 菜单开：点外部关；Esc 关（面板 Esc 守卫已让位）
  useEffect(() => {
    if (!cwdPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (cwdMenuRef.current && !cwdMenuRef.current.contains(e.target as Node)) setCwdPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setCwdPickerOpen(false); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [cwdPickerOpen]);
  // §12.1 shortcuts: Cmd/Ctrl+F focuses the search box, Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape") {
        // While typing (rename input / tag editor) the input handles Esc itself
        // (capture-phase panel handler must not steal it).
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
        // 子弹窗（移动对话框/目录选择器）打开时 Esc 只归它自己——否则本 handler
        // （先注册先执行）会把整个面板连带关掉。moveOpen = move-dialog 模块态订阅。
        if (cwdPickerOpen || moveOpen) return;
        panelOpen.onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cwdPickerOpen, moveOpen]);

  // §14.2: search queries carry model/role filters into the index; list mode filters locally.
  useEffect(() => {
    const qq = debounced.trim();
    if (!qq) { setSearchHits(null); return; }
    let alive = true;
    const params = new URLSearchParams({ q: qq, limit: "300" });
    if (modelFilter) params.set("model", modelFilter);
    if (roleFilter) params.set("role", roleFilter);
    fetch(apiUrl(`/api/extensions/session-manager/search?${params}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setSearchHits(d.hits ?? []); })
      .catch(() => { if (alive) setSearchHits([]); });
    return () => { alive = false; };
  }, [debounced, modelFilter, roleFilter]);

  // Archive status strip (candidates / cache)
  const refreshArchStatus = () => {
    fetch(apiUrl("/api/extensions/session-manager/archive/status"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setArchStatus(d))
      .catch(() => {});
  };
  // §14.3 stats (totals / models / heatmap) — loaded on demand + for the filter menu.
  const refreshStats = () => {
    fetch(apiUrl("/api/extensions/session-manager/stats"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStats(d))
      .catch(() => {});
  };
  useEffect(() => { if (statsOpen || filterOpen) refreshStats(); }, [statsOpen, filterOpen]);
  const runArchiveNow = async () => {
    if (archBusy) return;
    setArchBusy(true);
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/archive/run"), { method: "POST" });
      if (res.ok) {
        await res.json();
        refreshArchStatus();
        refreshListChannels(); // 左栏 dock 渲染 scoped 桶，只刷全量则归档行残留
      }
    } finally {
      setArchBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refreshSessions();
    void ensureTags();
    void refreshSources();
    refreshArchStatus();
    // 零轮询：订阅宿主共享 broker（页面级单例；旧宿主回退原生 EventSource）——服务端
    // running 集合变化才广播（新会话创建/结束都会触发）→ 事件驱动 refreshSessions。
    // 只过滤 running 帧：共享 broker 也转发其它扩展帧（pf:remind/mc:avail/ed-watch），
    // 那些不该触发会话列表全量拉取（3s 节流+并发合流虽能兜底，但语义上不该打）。
    const unsub = subscribeRunningFrames((frame) => {
      if (frame?.type !== "running" || !Array.isArray(frame.runningSessionIds)) return;
      // 新 id 出现（新会话开始跑）→ refresh=1 绕 5s 扫描缓存（jsonl 刚落盘/将落盘，
      // 普通刷新命中缓存拿不到新行）；其余变化帧普通刷新（合流节流兑底）。
      const hasNewId = (frame.runningSessionIds as string[]).some((id) => !store.running.has(id));
      void refreshSessions({ refresh: hasNewId });
    });
    return () => unsub();
  }, [open]);

  // T-1b+ : incremental "load more" for the big fav/running sections — they
  // render SECTION_PAGE_SIZE rows first, then grow per button click (completed
  // already paginates via PAGE_SIZE). State lives with the other hooks (must be
  // declared before the early return below — Rules of Hooks).
  const SECTION_PAGE_SIZE = 20;
  const [favLoaded, setFavLoaded] = useState(SECTION_PAGE_SIZE);
  const [runningLoaded, setRunningLoaded] = useState(SECTION_PAGE_SIZE);
  // Reset the incremental states whenever the underlying list identity changes
  // (filter/search) so pagination always starts from the first page.
  useEffect(() => { setFavLoaded(SECTION_PAGE_SIZE); setRunningLoaded(SECTION_PAGE_SIZE); }, [debounced, modelFilter, roleFilter, datePreset, cwdFilter, archivedOnly, favOnly, selectedTags.join("\u0000")]);

  // ── A16① 联合 tag 视图：选中 tag 时拉取该 tag（含子树）关联的文档（doc-center 经本扩展代理），
  // 会话列表照旧 tag 过滤——一个 tag 同时看会话与文档，跨维检索零跳转。──
  const [tagDocs, setTagDocs] = useState<{ docs: any[]; open: boolean }>({ docs: [], open: false });
  const tagKeySig = selectedTags.join("\u0000");
  useEffect(() => {
    const data0: any = s.tagData ?? { tags: [] };
    const byId0 = new Map((data0.tags ?? []).map((n: any) => [n.id, n]));
    const keys = selectedTags.map((id) => byId0.get(id)?.name).filter(Boolean);
    if (!keys.length) {
      setTagDocs({ docs: [], open: false });
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(apiUrl("/api/extensions/session-manager/doc-list?" + new URLSearchParams({ tag: keys.join(","), limit: "50" })), { signal: controller.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const d = await res.json() as { docs?: any[] };
        if (!controller.signal.aborted) setTagDocs({ docs: d.docs ?? [], open: true });
      } catch {
        if (!controller.signal.aborted) setTagDocs({ docs: [], open: false });
      }
    })();
    return () => controller.abort();
  }, [tagKeySig, open]);

  if (!open) return null;

  const data = s.tagData ?? EMPTY_TAGS;
  const byId = byIdMap(data);
  const q = debounced.trim();
  const activeFilterCount =
    (archivedOnly ? 1 : 0) + (favOnly ? 1 : 0) + selectedTags.length +
    (modelFilter ? 1 : 0) + (roleFilter ? 1 : 0) + (datePreset ? 1 : 0) + (cwdFilter ? 1 : 0);

  // When searching, the index is the source (live + archived unified).
  const base: any[] = searchHits
    ? searchHits.map((h) => ({
        id: h.sessionId,
        // composite ids ("claude:<sid>") carry the source agent — keep the filter honest
        agent: h.sessionId.includes(":") ? h.sessionId.slice(0, h.sessionId.indexOf(":")) : "pi",
        name: h.title, cwd: h.cwd, modified: h.modified,
        firstMessage: h.text, lastMessage: h.text, lastRole: h.role, archived: h.archived, messageCount: 0,
      }))
    : [...(s.sessions ?? []), ...(s.archived ?? [])]; // 服务端拆分返回（live/archived 两桶）；面板合并视图，下方 favIds 例外过滤照旧
  const byIdL = new Map(base.map((x) => [x.id, x]));

  // §14.2.2/14.2.3: local filters (list mode) + sort.
  // Archived sessions are HIDDEN by default — the 📦 已归档 chip opts in
  // (and then shows archived only). Exception: FAVOURITED sessions keep
  // appearing in the default favourites section even after archiving.
  const favIds = new Set<string>(data.favoriteIds);
  const archivedCount = base.reduce((n, x) => n + (x.archived ? 1 : 0), 0);
  const agentOf = (x: any) => x.agent ?? "pi";
  const filtered = base.filter((sess) =>
    agentFilter.has(agentOf(sess))
    && (archivedOnly ? sess.archived : !sess.archived || favIds.has(sess.id))
    && (!favOnly || favIds.has(sess.id))
    && matchesTags(sess.id, data, selectedTags)
    && (!modelFilter || sess.model === modelFilter)
    && (!cwdFilter || underRoot(sess.cwd, cwdFilter))
    && dateFilterMatches(sess.modified, datePreset));
  const favorites = filtered.filter((x) => favIds.has(x.id));
  const runningList = filtered.filter((x) => s.running.has(x.id) && !favIds.has(x.id));
  const sortVal = (x: any): string | number => {
    if (sortBy === "created") return x.created ?? "";
    if (sortBy === "name") return (x.name ?? x.firstMessage ?? "").toLowerCase();
    if (sortBy === "messageCount") return x.messageCount ?? 0;
    return x.modified ?? "";
  };
  const cmp = (a: any, b: any) => {
    const va = sortVal(a);
    const vb = sortVal(b);
    let r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sortAsc ? r : -r;
  };
  const completed = filtered.filter((x) => !s.running.has(x.id) && !favIds.has(x.id)).sort(cmp);
  // Slice the fav/running lists down to the incremental "load more" page.
  const favoritePage = favorites.slice(0, favLoaded);
  const runningPage = runningList.slice(0, runningLoaded);
  // §14.4: prune selection of sessions that disappeared under the current filter.
  if (selection.size) {
    const aliveIds = new Set(filtered.map((x) => x.id));
    if ([...selection].some((id) => !aliveIds.has(id))) {
      setSelection(new Set([...selection].filter((id) => aliveIds.has(id))));
    }
  }

  const pages = Math.max(1, Math.ceil(completed.length / PAGE_SIZE));
  const pageClamped = Math.min(page, pages - 1);
  const pageItems = completed.slice(pageClamped * PAGE_SIZE, (pageClamped + 1) * PAGE_SIZE);

  // §4.2 filter chips: usage counts (incl. descendants) + expandable parents.
  const usageCount = (nodeId: string) => {
    const set = new Set(descendantsLocal(nodeId, byId));
    return base.filter((x) => sessionTagIds(x.id, data).some((tid) => set.has(tid))).length;
  };
  const chipRow = (node: any, depth: number): any[] => {
    const children = data.tags.filter((n: any) => n.parentId === node.id)
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    const count = usageCount(node.id);
    // 计数为 0 的 tag 不显示（计数含后代汇总：子树全空 → 整枝隐藏；
    // 当前已选中的 tag 豁免——活动过滤 chip 始终可见、可点击取消）。
    if (count === 0 && !selectedTags.includes(node.id)) return [];
    const isParent = children.length > 0;
    const expanded = expandedTags.has(node.id);
    return [
      (
        <span
          key={node.id}
          onClick={() => toggleSharedFilter(node.id)}
          title={tagPath(node.id, data)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            marginLeft: depth * 14,
            padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
            background: selectedTags.includes(node.id) ? node.color + "33" : node.color + "1a",
            color: node.color,
            border: `1px solid ${selectedTags.includes(node.id) ? node.color : node.color + "33"}`,
          }}
        >
          {isParent && (
            <span
              onClick={(e) => { e.stopPropagation(); setExpandedTags((prev) => { const n = new Set(prev); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); }}
              style={{ cursor: "pointer", fontSize: 9, color: "inherit", opacity: 0.8 }}
            >{expanded ? "▾" : "▸"}</span>
          )}
          {node.name}
          <span style={{ opacity: 0.75, fontSize: 9 }}>{count}</span>
        </span>
      ),
      ...(expanded ? children.flatMap((c: any) => chipRow(c, depth + 1)) : []),
    ];
  };

  /* §14.3 stat card + heatmap grid + batch ops */
  const statCard = (icon: string, value: string, label: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 9, background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{label}</div>
      </div>
    </div>
  );
  const HEAT_COLORS = ["var(--bg-hover)", "rgba(16,185,129,0.25)", "rgba(16,185,129,0.45)", "rgba(16,185,129,0.7)", "#10b981"];
  const heatmapGrid = (points: any[], onPick: (date: string) => void) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(26, 1fr)", gap: 2, maxHeight: 120, overflowY: "auto" }}>
      {points.map((p) => (
        <div
          key={p.date}
          title={`${p.date} · ${p.messages} 条 · ${p.sessions} 会话`}
          onClick={() => p.messages > 0 && onPick(p.date)}
          style={{
            aspectRatio: "1", borderRadius: 2, cursor: p.messages > 0 ? "pointer" : "default",
            background: HEAT_COLORS[p.level],
            border: p.messages > 0 && p.level === 0 ? "1px solid rgba(16,185,129,0.3)" : "none",
          }}
        />
      ))}
    </div>
  );
  const batchArchive = async () => {
    // running sessions are never archived (server also enforces this)
    const ids = [...selection].filter((id) => !s.running.has(id) && !(byIdL.get(id)?.archived));
    if (ids.length === 0) {
      window.alert?.(`没有可归档的会话（运行中/已归档已跳过）`);
      return;
    }
    setArchiveDialogIds(ids);
  };
  const batchFavorite = async () => {
    if (batchBusy) return;
    setBatchBusy(true);
    try {
      for (const id of selection) await act("favorite", { sessionId: id });
      setSelection(new Set());
    } finally { setBatchBusy(false); }
  };
  const batchDelete = async () => {
    if (batchBusy) return;
    // 彻底删除（活）：只删未归档活会话；已归档项跳过（归档记录删除在已归档行的 ⋮）。
    const ids = [...selection].filter((id) => !byIdL.get(id)?.archived);
    const skipped = selection.size - ids.length;
    if (ids.length === 0) {
      showConfirm({
        title: t("sm.batchDeleteTitle") ?? "批量删除",
        message: t("sm.noLiveToDelete") ?? "没有未归档的会话可删除（已归档会话请到已归档行删除）",
        info: true,
      });
      return;
    }
    showConfirm({
      title: t("sm.batchDeleteTitle") ?? "批量删除",
      message: t("sm.batchDeleteMsg", { count: ids.length }) ?? `永久删除 ${ids.length} 个未归档会话，不可恢复；运行中会先停止。确定继续？`,
      confirmLabel: t("sm.archiveDelete") ?? "彻底删除",
      danger: true,
      onConfirm: async () => {
        setBatchBusy(true);
        // 确认后：先置灰全部目标行（后台刷新慢，让用户知道在动），失败逐行恢复
        for (const id of ids) markPendingRemoval(id, "live");
        try {
          let failed = 0;
          for (const id of ids) {
            const e = await deleteLiveSession(id);
            if (e) { failed++; clearPendingRemoval(id); }
          }
          setSelection(new Set());
          void refreshSessions();
          notifySessionsChanged();
          if (failed > 0) {
            showConfirm({ title: t("sm.batchDeleteTitle") ?? "批量删除", message: t("sm.batchDeleteFailed", { count: failed }) ?? `${failed} 个删除失败`, info: true });
          } else if (skipped > 0) {
            showConfirm({ title: t("sm.batchDeleteTitle") ?? "批量删除", message: t("sm.batchDeleteSkipped", { count: skipped }) ?? `跳过 ${skipped} 个已归档会话（归档记录删除请到已归档行操作）`, info: true });
          }
        } finally {
          setBatchBusy(false);
        }
      },
    });
  };
  const startRename = (sess: any) => {
    setRenamingId(sess.id);
    // 无存储名时回退首消息（前 50 字），与 dock 行内改名默认值对齐；避免空输入框
    const first = sess.firstMessage ? String(sess.firstMessage).slice(0, 50) : "";
    setRenameVal(sess.name || first || String(sess.id ?? "").slice(0, 12));
  };
  const submitRename = async () => {
    const id = renamingId;
    const name = renameVal.trim();
    setRenamingId(null);
    if (!id || !name) return;
    const res = await fetch(apiUrl(`/api/sessions/${id}`), {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) applySessionNameLocal(id, name); // 就地更新 store：UI 立即反映，不等列表刷新往返
    void refreshSessions(); // 后台对齐（节流合流；服务端 rev 指纹含 name）
  };
  // AI 自动生成会话名（pi-web core auto-name 端点；归档/外部会话不适用）
  const doAutoName = async (sess: any) => {
    const key = "auto:" + sess.id;
    if (isBusy(key)) return;
    // 桥占用 → 降级为手动重命名（菜单 onClick 已探测，此处为直调路径兜底）
    try {
      const pr = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sess.id)}/state`));
      const pd = await pr.json().catch(() => ({}));
      if ((pr.ok && pd.bridged === true) || (!pr.ok && pd.code === "session_bridged_unreachable")) {
        showToast(t("sm.autoNameBridged") ?? "该会话正由终端（TUI）占用，无法自动生成名字，请手动命名。");
        startRename(sess);
        return;
      }
    } catch { /* 探测失败走原流程 */ }
    markBusy(key);
    try {
      const res = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sess.id)}/auto-name`), { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.title) window.alert?.(`${t("sm.autoNameFailed") ?? "生成名字失败"}：${d.error ?? res.status}`);
      else {
        applySessionNameLocal(sess.id, d.title); // 就地更新 store（同重命名，不等列表刷新）
        void refreshSessions(); // 后台对齐
      }
    } catch (e) {
      window.alert?.(`${t("sm.autoNameFailed") ?? "生成名字失败"}：${e instanceof Error ? e.message : String(e)}`);
    } finally { markDone(key); }
  };

  const row = (sess: any) => {
    // 移除操作进行中（归档/删除/从列表移除，带桶：live 视图 vs 归档视图）→ 置灰 + 禁点
    const pending = isPendingRemoval(sess.id, sess.archived ? "archived" : "live");
    return (
    <div
      key={sess.id}
      onClick={() => {
        // 点开会话不再顺带关掉启动器：桌面浮窗与右栏停靠都不遮挡，面板留着可连续点选。
        // 仅小屏（≤640px）浮窗会铺满视口盖住刚打开的会话/查看器（表现为「点了没反应，
        // 还在看 All Sessions」）——那种场合才让位。
        if (sess.archived) openViewer(sess.id);
        else if (sess.agent && sess.agent !== "pi") openExtViewer(sess.id);
        else props.onSelectSession?.(sess);
        collapsePanelIfCovering();
      }}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
        cursor: "pointer", borderRadius: 7,
        opacity: pending ? 0.45 : 1,
        pointerEvents: pending ? "none" : undefined,
        transition: "opacity .15s, background .15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
    >
      {/* §14.4 batch checkbox (hover-visible) */}
      <span
        onClick={(e) => {
          e.stopPropagation();
          setSelection((prev) => { const n = new Set(prev); if (n.has(sess.id)) n.delete(sess.id); else n.add(sess.id); return n; });
        }}
        style={{
          flexShrink: 0, cursor: "pointer", userSelect: "none", width: 16, textAlign: "center",
          fontSize: 13, opacity: selection.has(sess.id) ? 1 : 0.25,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={(e) => { if (!selection.has(sess.id)) e.currentTarget.style.opacity = "0.25"; }}
      >{selection.has(sess.id) ? "☑" : "☐"}</span>
      <div style={{ width: 14, flexShrink: 0, color: "var(--accent)", fontSize: 11, textAlign: "center" }}>
        {pending ? "⏳" : s.running.has(sess.id) ? "⟳" : sess.archived ? "📦" : ""}
      </div>
      {/* M1: external-agent badge */}
      {sess.planFirst && (
        <span title="方案先行：已绑定方案文档（aiti-plan-first）" style={{ flexShrink: 0, fontSize: 10, color: "#3fb950", border: "1px solid #3fb95055", borderRadius: 4, padding: "0 4px", lineHeight: 1.5 }}>📋</span>
      )}
      {agentBadge(sess.agent)}
      <div style={{ flex: 1, minWidth: 0 }}>
        {renamingId === sess.id
          ? <input
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onBlur={() => void submitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void submitRename(); }
                if (e.key === "Escape") { setRenameVal(""); setRenamingId(null); }
              }}
              style={{ ...(inputStyle as any), padding: "2px 6px", fontSize: 12, marginBottom: 2 }}
              autoFocus={true}
            />
          : <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
              {/* §14.2.6: search hits render the snippet with <mark> highlights */}
              {searchHits
                ? <span style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} dangerouslySetInnerHTML={{ __html: highlight(sess.firstMessage, q) }} />
                : <span style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sessionTitle(sess)}</span>}
              {/* 子代理徽标：header.parentSessionId 存在 = 该会话是某父会话的子代理（fork 创建） */}
              {sess.parentSessionId && (
                <span title={`子代理 · 父会话 ${String(sess.parentSessionId).slice(0, 12)}`} style={{ fontSize: 9, padding: "0 5px", borderRadius: 7, flexShrink: 0, background: "rgba(139,92,246,0.16)", color: ensureReadability("#a78bfa"), border: "1px solid rgba(139,92,246,0.3)", lineHeight: "14px" }}>
                  🤖 子代理
                </span>
              )}
              {/* 移除进行中标注（归档/删除/从列表移除——后台刷新慢，告知用户在工作） */}
              {pending && (
                <span title={t("sm.pendingRemoval") ?? "正在移除…"} style={{ fontSize: 10, fontStyle: "italic", color: "var(--text-dim)", flexShrink: 0, whiteSpace: "nowrap" }}>
                  {t("sm.pendingRemoval") ?? "处理中…"}
                </span>
              )}
              {/* 运行终态徽标（failed/aborted/interrupted；completed 不显示；运行中优先） */}
              {!s.running.has(sess.id) && sess.lastRun && sess.lastRun.status !== "completed" && (
                <span
                  title={
                    sess.lastRun.status === "failed" && sess.lastRun.error
                      ? t("sm.runFailedWithError", { error: truncateRunErrorText(sess.lastRun.error, 80) })
                      : sess.lastRun.status === "failed"
                        ? t("sm.runFailed")
                        : sess.lastRun.status === "aborted"
                          ? t("sm.runAborted")
                          : t("sm.runInterrupted")
                  }
                  style={{
                    fontSize: 9, padding: "0 5px", borderRadius: 7, flexShrink: 0, lineHeight: "14px",
                    background: sess.lastRun.status === "failed" ? "rgba(239,68,68,0.14)" : sess.lastRun.status === "aborted" ? "rgba(148,163,184,0.16)" : "rgba(245,158,11,0.16)",
                    color: sess.lastRun.status === "failed" ? "var(--danger, #ef4444)" : sess.lastRun.status === "aborted" ? "var(--text-dim)" : "var(--warn, #f59e0b)",
                    border: `1px solid ${sess.lastRun.status === "failed" ? "rgba(239,68,68,0.35)" : sess.lastRun.status === "aborted" ? "rgba(148,163,184,0.35)" : "rgba(245,158,11,0.35)"}`,
                  }}
                >
                  {sess.lastRun.status === "failed" ? t("sm.runFailed") : sess.lastRun.status === "aborted" ? t("sm.runAborted") : t("sm.runInterrupted")}
                </span>
              )}
            </div>}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 1, fontSize: 11, color: "var(--text)", opacity: 0.72 }}>
          <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{displayCwd(sess.cwd)}</span>
          <span>{fmtRelative(sess.modified)}</span>
          <span>{t("sm.msgCount", { count: sess.messageCount })}</span>
          {/* §14.4.1 last-role badge */}
          {sess.lastRole && <span title={`最后角色: ${sess.lastRole}`}>{roleBadge(sess.lastRole)}</span>}
        </div>
        {/* §14.4.1 last message summary line */}
        {sess.lastMessage && (
          <div style={{ marginTop: 2, fontSize: 11, color: "var(--text)", opacity: 0.66, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sess.lastMessage.length > 60 ? sess.lastMessage.slice(0, 60) + "…" : sess.lastMessage}
          </div>
        )}
        {/* 失败原因摘要（→120 字符压平；点击行仍是打开会话，完整错误在会话内） */}
        {sess.lastRun?.status === "failed" && sess.lastRun.error && (
          <div
            title={sess.lastRun.error}
            style={{ marginTop: 2, fontSize: 11, color: "var(--danger, #ef4444)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {truncateRunErrorText(sess.lastRun.error, 60)}
          </div>
        )}
        {sessionTagIds(sess.id, data).length > 0 && (
          <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
            {sessionTagIds(sess.id, data).map((tid) => (
              <TagChip
                key={tid} tagId={tid} data={data}
                onClick={() => toggleSharedFilter(tid)}
              />
            ))}
          </div>
        )}
      </div>
      <StarButton
        sessionId={sess.id}
        onToggle={(on) => void act(on ? "favorite" : "unfavorite", { sessionId: sess.id })}
      />
      <TagEditPopover sessionId={sess.id} />
      {/* 单一 📦 ▾ → 原地展开 4 选项（已解决/未解决/直接/彻底删除）；仅未归档 + 非运行中的 pi 会话 */}
      {(!sess.archived && (!sess.agent || sess.agent === "pi") && !s.running.has(sess.id)) && (
        <ArchiveMenu sessionId={sess.id} />
      )}
      {/* M1: external rows — live takeover (backend-extension continuation) + import */}
      {sess.agent && sess.agent !== "pi" && (
        <>
          <button
            title="打开(接管)——通过后端扩展继续此会话（需安装对应 ati-*-agent 扩展）"
            disabled={isBusy(sess.id)}
            onClick={(e) => {
              e.stopPropagation();
              if (isBusy(sess.id)) return;
              const key = "live:" + sess.id;
              markBusy(key);
              void openLiveSession(sess.id, sess.cwd)
                .then((r) => {
                  if (r.ok) {
                    props.onSelectSession?.({
                      id: r.sessionId,
                      path: "",
                      cwd: sess.cwd ?? "",
                      name: sessionTitle(sess),
                      created: sess.created ?? new Date().toISOString(),
                      modified: new Date().toISOString(),
                      messageCount: sess.messageCount ?? 0,
                      firstMessage: sess.firstMessage ?? "",
                      transient: true,
                    });
                    collapsePanelIfCovering();
                  } else {
                    window.alert?.(
                      r.reason === "no_provider"
                        ? "未安装能驱动该 agent 的后端扩展（如 aiti-claude-code-agent）"
                        : `打开失败：${r.error ?? r.reason}`,
                    );
                  }
                })
                .finally(() => markDone(key));
            }}
            style={{ ...miniBtn, opacity: isBusy(sess.id) ? 0.8 : 0.45, fontSize: 10, flexShrink: 0, color: ensureReadability("#a78bfa") }}
          >{isBusy(sess.id) ? "⟳" : "⚡"}</button>
          <button
            title={t("sm.import.button")}
            onClick={(e) => {
              e.stopPropagation();
              openExtViewer(sess.id);
              collapsePanelIfCovering(); // 同行点击：仅小屏全屏浮窗会盖住查看器，那时才让位
            }}
            style={{ ...miniBtn, opacity: 0.45, fontSize: 10, flexShrink: 0, color: ensureReadability("var(--ok, #22c55e)") }}
          >⬇</button>
        </>
      )}
      {/* 「⋯」更多菜单：编辑/生成名字/移动等低频操作。归档/彻底删除已收进行内 📦 ▾（ArchiveMenu），此处不再重复。
          live pi 全量项经 buildLivePiRowMenuItems（row-menu.tsx）—— 与 SidebarDock 左栏行同一份菜单；
          archived：重开（恢复并打开）/恢复/彻底删除（归档记录）+ 相关文档。外部 agent 行不提供（它们有专属的 ⚡/⬇）。 */}
      {(() => {
        const isPi = !sess.agent || sess.agent === "pi";
        const running = s.running.has(sess.id);
        const items: MenuItem[] = [];
        if (!sess.archived && isPi) {
          items.push(...buildLivePiRowMenuItems({
            sess,
            running,
            startRename: () => startRename(sess),
            onMove: () => showMoveDialog(sess),
            // 面板沿用自身 rowBusy 记账（行内 ⚡ 按钮同源）；不传则回落模块级 runAutoNameSession
            autoNameBusy: isBusy("auto:" + sess.id),
            runAutoName: () => void doAutoName(sess),
          }));
        } else if (!sess.archived && !isPi) {
          // 外部源行（zcode/cursor 等只读镜像）：归档管线不收 → 提供视图层「从列表移除」（源数据不动，可恢复）。
          // 带子会话（外部子代理链 parentSessionId）时平铺两项：连同子会话一起移除 vs 仅移除自己
          // （否则只移除主会话，子会话留在列表变孤儿）——与行内 📦（ArchiveMenu）平铺同语义。
          const extChildIds = collectSubtreeIds(store.sessions, String(sess.id));
          const extHideRun = async (ids: string[]) => {
            if (isBusy(sess.id)) return;
            markBusy(sess.id);
            // 先置灰涉及行（后台刷新慢，让用户知道在动），失败恢复样式
            for (const id of ids) markPendingRemoval(id, "live");
            for (const id of ids) {
              const ok = await hideExtSession(id, true);
              if (!ok) {
                for (const x of ids) clearPendingRemoval(x);
                window.alert?.(`${String(id).slice(0, 8)} 移除失败`);
                break;
              }
            }
            markDone(sess.id);
          };
          if (extChildIds.length) {
            items.push({
              key: "ext-hide-all", icon: "🚫", label: t("sm.extFlatTogether", { count: extChildIds.length }) ?? `从列表移除（连同 ${extChildIds.length} 个子会话）`,
              disabled: isBusy(sess.id),
              onClick: () => void extHideRun([String(sess.id), ...extChildIds]),
            });
            items.push({
              key: "ext-hide-self", icon: "🔒", label: t("sm.extFlatKeep") ?? "从列表移除（仅自己）",
              disabled: isBusy(sess.id),
              onClick: () => void extHideRun([String(sess.id)]),
            });
          } else {
            items.push({
              key: "ext-hide", icon: "🚫", label: t("sm.extRemove") ?? "从列表移除",
              disabled: isBusy(sess.id),
              onClick: () => void extHideRun([String(sess.id)]),
            });
          }
        } else if (sess.archived) {
          const isExtArchived = (sess as { archiveRef?: string }).archiveRef === "__ext__";
          items.push({
            key: "reopen", icon: "📂", label: t("sm.reopen") ?? "重开（恢复并打开）",
            disabled: isBusy(sess.id),
            onClick: () => {
              if (isBusy(sess.id)) return;
              markBusy(sess.id);
              markPendingRemoval(sess.id, "archived");
              void restoreSession(sess.id).then((ok) => {
                if (!ok) { clearPendingRemoval(sess.id); window.alert?.(`${t("sm.reopenFailed") ?? "重开失败"}：${sess.id.slice(0, 8)}`); return; }
                // ext 视图层归档行：恢复后直接走后端扩展接管（⚡ 同链路）
                if (isExtArchived) {
                  return openLiveSession(sess.id, sess.cwd).then((r) => {
                    if (r.ok) props.onSelectSession?.({ ...sess, archived: false, id: r.sessionId, transient: true });
                  });
                }
                props.onSelectSession?.({ ...sess, archived: false });
                collapsePanelIfCovering();
              }).finally(() => markDone(sess.id));
            },
          });
          items.push({
            key: "restore", icon: "↩️", label: t("sm.restore") ?? "恢复为普通会话",
            disabled: isBusy(sess.id),
            onClick: () => {
              if (isBusy(sess.id)) return;
              markBusy(sess.id);
              markPendingRemoval(sess.id, "archived");
              void restoreSession(sess.id)
                .then((ok) => {
                  if (!ok) {
                    // 失败必须可见（对齐 reopen/delete 路径）：曾因服务端读写成路径分裂导致
                    // restore 404 而这里静默回滚样式，用户只看到「没成功也没报错」
                    clearPendingRemoval(sess.id);
                    window.alert?.(`${t("sm.restoreFailed") ?? "恢复失败"}：${sess.id.slice(0, 8)}`);
                  }
                })
                .finally(() => markDone(sess.id));
            },
          });
          if (!isExtArchived) items.push({
            key: "delete", icon: "🗑️", danger: true, label: t("sm.deleteArchive") ?? "彻底删除",
            disabled: isBusy(sess.id),
            onClick: () => {
              if (isBusy(sess.id)) return;
              // 自绘确认弹窗（替换浏览器原生 confirm）
              showConfirm({
                title: t("sm.deleteArchive") ?? "彻底删除",
                message: t("sm.confirmDeleteArchive") ?? "彻底删除该已归档会话？先归档才能删除，删后不可恢复。",
                confirmLabel: t("sm.archiveDelete") ?? "彻底删除",
                danger: true,
                onConfirm: () => {
                  markBusy(sess.id);
                  // 确认后才置灰（后台刷新慢），失败恢复样式
                  markPendingRemoval(sess.id, "archived");
                  return deleteArchivedSession(sess.id)
                    .then((ok) => { if (!ok) clearPendingRemoval(sess.id); })
                    .finally(() => markDone(sess.id));
                },
              });
            },
          });
          items.push({ key: "related-docs", icon: <SIc name="fileText" size={13} />, label: t("sm.relatedDocs") ?? "相关文档", onClick: () => showRelatedDocs(sess.id, sessionTitle(sess)) });
          // 已归档 pi 会话的台账仍在（归档不动 git-trace configDir）→ 时间线照常可看；外部镜像行不追踪，不给入口
          if (!isExtArchived) items.push({ key: "timeline", icon: "⎇", label: t("sm.timeline") ?? "时间线", onClick: () => openSessionTimeline(sess.id) });
        }
        return items.length > 0 ? <RowMenu items={items} /> : null;
      })()}
    </div>
    );
  };

  // section renders `items` (already sliced to the loaded page). If the
  // underlying list has more rows than the page, a "load more" button grows
  // the page by onMore() (incremental loading — see SECTION_PAGE_SIZE above).
  const section = (key: string, title: string, items: any[], total: number, onMore: (() => void) | null) =>
    items.length === 0 ? null : (
      <div key={key} style={{ marginBottom: 8, contain: "layout style" }}>
        <div
          onClick={() => toggleSection(key)}
          style={{
            fontSize: 11, fontWeight: 600, color: "var(--text-muted)", padding: "4px 10px",
            letterSpacing: "0.04em", textTransform: "uppercase",
            cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4,
          }}
        >
          <span
            style={{
              fontSize: 9, display: "inline-block", transition: "transform 0.15s",
              transform: collapsedSections.has(key) ? "rotate(-90deg)" : "none",
            }}
          >▾</span>
          {`${title} (${total})`}
        </div>
        {!collapsedSections.has(key) && (
          <div style={{ contain: "layout style", contentVisibility: "auto" }}>
            {items.map(row)}
            {onMore && total > items.length && (
              <div style={{ padding: "4px 10px" }}>
                <button onClick={onMore} style={ghostBtn}>{t("sm.loadMore", { n: Math.min(SECTION_PAGE_SIZE, total - items.length) })}</button>
              </div>
            )}
          </div>
        )}
      </div>
    );

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 290,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center",
        // T-2: fade the frame in with opacity — a compositor-only animation,
        // so opening never forces a synchronous layout of the dialog tree.
        animation: "sm-panel-fade 0.12s ease-out",
      }}
      onClick={() => panelOpen.onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // aiti-float 浮动契约：拖拽/缩放/位置持久化/自动最大化按钮；小屏全屏。
        // 首个子元素（标题栏）= 拖拽把手（搜索框/按钮等交互元素不触发拖拽）。
        // style 尺寸保留作未装 aiti-float 时的兜底居中弹窗。
        {...(embedded ? {} : { "data-ext-float": "1", "data-ext-float-w": 680, "data-ext-float-h": 700, "data-ext-float-full": "1" })}
        style={embedded ? {
          width: "100%", height: "100%",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", overflow: "hidden",
        } : {
          width: "min(680px, 94vw)", height: "min(78vh, 700px)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 14, overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        {/* header: title + search + filters/stats + archive strip */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 13, color: "var(--text)", whiteSpace: "nowrap" }}>{t("sm.allSessions")}</strong>
          <input
            ref={searchRef}
            value={query}
            placeholder={t("sm.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            style={inputStyle as React.CSSProperties}
          />
          {/* 目录过滤入口（弹出 aiti-folder WorkspaceDropdown：已知 workspace 优先）：与 ⚙ 并列；默认不选=全部 */}
          <span ref={cwdMenuRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
            <button
              onClick={() => setCwdPickerOpen((v) => !v)}
              title={cwdFilter ? `${cwdFilter} · ${t("sm.dir.change")}` : t("sm.dir.pick")}
              style={{
                ...ghostBtn, fontSize: 11, minWidth: 0, maxWidth: 150,
                display: "inline-flex", alignItems: "center", gap: 4,
                background: cwdFilter ? "var(--accent)" : undefined,
                borderColor: cwdFilter ? "var(--accent)" : undefined,
                color: cwdFilter ? "var(--bg)" : undefined,
              } as React.CSSProperties}
            >
              {/* 路径名自身截断，✕ 永不裁剪（flexShrink:0）——长路径下也始终可见可点 */}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{`${cwdFilter ? displayCwd(cwdFilter) : t("sm.dir.all")}`}</span>
              {cwdFilter && (
                <span
                  onClick={(e) => { e.stopPropagation(); setCwdFilter(""); setPage(0); }}
                  title={t("sm.clearAll")}
                  style={{ flexShrink: 0, opacity: 0.7 }}
                >✖</span>
              )}
            </button>
            {cwdPickerOpen && (
              <WorkspaceDropdown
                selected={cwdFilter || undefined}
                align="right"
                showUseDefault={false}
                allOption={{ label: t("sm.dir.all") }}
                onSelect={(p) => { setCwdPickerOpen(false); setCwdFilter(p || ""); setPage(0); }}
                onClose={() => setCwdPickerOpen(false)}
              />
            )}
          </span>
          {/* §14.2 filter menu trigger (active-count badge) */}
          <button
            onClick={() => setFilterOpen((v) => !v)}
            title={t("sm.filter")}
            style={{
              ...ghostBtn, fontSize: 11, position: "relative",
              background: activeFilterCount ? "var(--accent)" : undefined,
              borderColor: activeFilterCount ? "var(--accent)" : undefined,
              color: activeFilterCount ? "var(--bg)" : undefined,
            } as React.CSSProperties}
          >{`${activeFilterCount ? " " + activeFilterCount : ""}`}</button>
          {/* §14.3 stats drawer trigger */}
          <button
            onClick={() => { setStatsOpen((v) => !v); setFilterOpen(false); }}
            title={t("sm.stats")}
            style={{ ...ghostBtn, fontSize: 11, background: statsOpen ? "rgba(16,185,129,0.18)" : undefined } as React.CSSProperties}
          >📊</button>
          {archStatus && archStatus.candidates.length > 0 && (
            <button
              onClick={() => void runArchiveNow()}
              disabled={archBusy}
              title={archStatus.candidates.map((c: any) => c.sessionId.slice(0, 8)).join(", ")}
              style={{ ...ghostBtn, color: ensureReadability("var(--warn, #f59e0b)"), borderColor: "#f59e0b55", whiteSpace: "nowrap", fontSize: 10 } as React.CSSProperties}
            >{archBusy ? "…" : `${archStatus.candidates.length}`}</button>
          )}
          {archStatus && archStatus.cacheBytes > 0 && (
            <button
              onClick={async () => {
                const res = await fetch(apiUrl("/api/extensions/session-manager/archive/cache?clear=1"));
                if (res.ok) refreshArchStatus();
              }}
              title={t("sm.clearCache")}
              style={{ ...ghostBtn, fontSize: 10, whiteSpace: "nowrap" } as React.CSSProperties}
            >{`${(archStatus.cacheBytes / 1048576).toFixed(1)}M`}</button>
          )}
          <button onClick={() => panelOpen.onClose()} aria-label={t("sm.close")} title={t("sm.close")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 } as React.CSSProperties}>✕</button>
        </div>
        {/* §14.2 filter menu (model / date / sort / role) */}
        {filterOpen && (
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap", padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "rgba(99,102,241,0.05)" }}>
            {/* model */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("sm.model")}</span>
              {(stats?.byModel ?? []).slice(0, 12).map((m: any) => (
                <span
                  key={m.model}
                  onClick={() => setModelFilter(modelFilter === m.model ? "" : m.model)}
                  style={{
                    cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                    background: modelFilter === m.model ? "var(--accent)" : "var(--bg-hover)",
                    color: modelFilter === m.model ? "var(--bg)" : "var(--text-muted)",
                  }}
                >{`${m.model} · ${m.sessions}`}</span>
              ))}
              {(stats?.byModel ?? []).length === 0 && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>…</span>}
            </div>
            {/* date */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("sm.date")}</span>
              {getDatePresets().map((p) => (
                <span
                  key={p.key || "__all__"}
                  onClick={() => setDatePreset(datePreset === p.key ? "" : p.key)}
                  style={{
                    cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                    background: datePreset === p.key ? "var(--accent)" : "var(--bg-hover)",
                    color: datePreset === p.key ? "var(--bg)" : "var(--text-muted)",
                  }}
                >{p.label()}</span>
              ))}
              {datePreset.startsWith("day:") && (
                <span style={{ fontSize: 11, color: "var(--accent)", background: "var(--bg-selected)", padding: "1px 7px", borderRadius: 8, cursor: "pointer" }} onClick={() => setDatePreset("")}>
                  {`${datePreset.slice(4)} ✖`}
                </span>
              )}
            </div>
            {/* sort */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("sm.sort")}</span>
              {["modified", "created", "name", "messageCount"].map((k) => (
                <span
                  key={k}
                  onClick={() => { setSortBy(k); if (sortBy === k) setSortAsc((v) => !v); }}
                  style={{
                    cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                    background: sortBy === k ? "var(--accent)" : "var(--bg-hover)",
                    color: sortBy === k ? "var(--bg)" : "var(--text-muted)",
                  }}
                >{`${k === "messageCount" ? t("sm.msgCountLabel") : k}${sortBy === k ? (sortAsc ? " ↑" : " ↓") : ""}`}</span>
              ))}
            </div>
            {/* role (search mode) + clear all */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("sm.roleSearch")}</span>
              {["user", "assistant", "toolResult"].map((r) => (
                <span
                  key={r}
                  onClick={() => setRoleFilter(roleFilter === r ? "" : r)}
                  style={{
                    cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                    background: roleFilter === r ? "var(--accent)" : "var(--bg-hover)",
                    color: roleFilter === r ? "var(--bg)" : "var(--text-muted)",
                  }}
                ><span key="icon" style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 2 }}>{roleBadge(r)}</span>{" " + r}</span>
              ))}
              <button
                onClick={() => { setModelFilter(""); setRoleFilter(""); setDatePreset(""); setCwdFilter(""); setArchivedOnly(false); setFavOnly(false); clearSharedFilter(); }}
                style={{ ...ghostBtn, fontSize: 10, marginTop: 2 } as React.CSSProperties}
              >{t("sm.clearAll")}</button>
            </div>
          </div>
        )}

        {/* §14.3 stats drawer */}
        {statsOpen && (
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "rgba(16,185,129,0.05)" }}>
            {!stats ? <div style={{ color: "var(--text-muted)", fontSize: 12 }}>…</div> : (
              <div>
                {/* 4 stat cards */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {statCard("🧾", `${stats.totals.totalSessions}`, t("sm.sessions"))}
                  {statCard("📦", `${stats.totals.archivedSessions}`, t("sm.archived"))}
                  {statCard("💬", `${stats.totals.totalMessages}`, "消息")}
                  {statCard("⟳", `${stats.totals.runningSessions}`, "运行中")}
                </div>
                <div style={{ display: "flex", gap: 16, marginTop: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                  {/* model distribution */}
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{t("sm.modelDist")}</div>
                    {(stats.byModel ?? []).slice(0, 6).map((m: any) => {
                      const max = Math.max(1, ...(stats.byModel ?? []).map((x: any) => x.messages));
                      return (
                        <div key={m.model} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, fontSize: 10 }}>
                          <span style={{ minWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>{m.model}</span>
                          <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden" }}>
                            <div style={{ width: `${Math.round((m.messages / max) * 100)}%`, height: "100%", background: "#10b981" }} />
                          </div>
                          <span style={{ color: "var(--text-muted)" }}>{String(m.messages)}</span>
                        </div>
                      );
                    })}
                  </div>
                  {/* heatmap — click a day to filter the list to that day */}
                  <div style={{ flex: 2, minWidth: 260 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{t("sm.activityHint")}</div>
                    {heatmapGrid(stats.heatmap, (day) => {
                      setDatePreset(`day:${day}`);
                      setStatsOpen(false);
                    })}
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, display: "flex", gap: 10 }}>
                      {t("sm.todayLine", { s: stats.totals.todaySessions, m: stats.totals.todayMessages })}
                      {t("sm.weekLine", { n: stats.totals.weekMessages })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* §14.4 batch bar */}
        {selection.size > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 12px", borderBottom: "1px solid var(--border)", background: "rgba(245,158,11,0.08)" }}>
            <span style={{ fontSize: 11, color: ensureReadability("var(--warn, #f59e0b)") }}>{t("sm.selectedCount", { count: selection.size })}</span>
            <button disabled={batchBusy} onClick={() => void batchArchive()} style={ghostBtn}>{`${t("sm.archive")}`}</button>
            <button disabled={batchBusy} onClick={() => setBatchMoveOpen(true)} style={ghostBtn}>{`${t("sm.moveBatch") ?? "移动到…"}`}</button>
            <button disabled={batchBusy} onClick={() => void batchFavorite()} style={ghostBtn}>{`${t("sm.favorite")}`}</button>
            <button disabled={batchBusy} onClick={() => void batchDelete()} style={{ ...ghostBtn, color: ensureReadability("var(--danger, #f87171)") } as React.CSSProperties}>{`${t("sm.archiveDelete")}`}</button>
            <button onClick={() => setSelection(new Set())} style={{ ...ghostBtn, marginLeft: "auto" } as React.CSSProperties}>清除</button>
          </div>
        )}

        {/* 小屏统一滚动：把「标签云 + agent 云 + 外部源条 + 会话列表」收进一个滚动容器（
            整窗一个滚动位置，不再是 3 个独立滚动）。向下滚动（内容上移）时标签/agent 云
            各自收拢到 2 行，顶部固定一条「… 展开/收拢」切换条。大屏（非 compact）不启用。 */}
        {compact && scrunch !== "full" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", borderBottom: "1px solid var(--border)", fontSize: 10, color: "var(--text-muted)", background: "rgba(99,102,241,0.05)" }}>
            <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {scrunch === "expanded" ? `${t("sm.expanded") ?? "已展开"} · ${t("sm.scrollToCollapse") ?? "再向下滚动自动收拢"}` : `${t("sm.cloudsCollapsed") ?? "标签 / 来源 已收拢"}`}
            </span>
            <button
              onClick={() => setScrunch((v) => (v === "expanded" ? "brief" : "expanded"))}
              style={{ ...ghostBtn, fontSize: 10, flexShrink: 0 } as React.CSSProperties}
            >{scrunch === "expanded" ? (`▲ ${t("sm.collapse") ?? "收拢"}`) : (`… ${t("sm.expand") ?? "展开"}`)}</button>
          </div>
        )}
        <div ref={scrunchRef} style={{ flex: 1, minHeight: 0, overflowY: compact ? "auto" : "hidden", contain: "layout style", ...(compact ? {} : { display: "flex", flexDirection: "column" }) }}>
        {/* tag filter chips — §4.2 counts (incl. descendants) + expandable parents */}
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", padding: "6px 12px", borderBottom: "1px solid var(--border)", maxHeight: compact && scrunch === "brief" ? 52 : (compact ? undefined : 110), overflowY: compact && scrunch === "brief" ? "hidden" : (compact ? undefined : "auto") }}>
          {/* §14.2.5 active-filter chips (model / date / role) — visible even when the menu is closed */}
          {modelFilter && (
            <span
              onClick={() => setModelFilter("")}
              title={t("sm.clearAll")}
              style={{ padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)" }}
            >{`${modelFilter} ✖`}</span>
          )}
          {datePreset && (
            <span
              onClick={() => setDatePreset("")}
              title={t("sm.clearAll")}
              style={{ padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)" }}
            >{`${datePreset.startsWith("day:") ? datePreset.slice(4) : getDatePresets().find((p) => p.key === datePreset)?.label() ?? datePreset} ✖`}</span>
          )}
          {roleFilter && (
            <span
              onClick={() => setRoleFilter("")}
              title={t("sm.clearAll")}
              style={{ padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)" }}
            ><span key="icon" style={{ display: "inline-flex", verticalAlign: "middle" }}>{roleBadge(roleFilter)}</span>{" " + roleFilter + " "}</span>
          )}
          {cwdFilter && (
            <span
              onClick={() => setCwdFilter("")}
              title={`${cwdFilter} · ${t("sm.clearAll")}`}
              style={{ padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)", fontFamily: "var(--font-mono)" }}
            >{`${displayCwd(cwdFilter)} ✖`}</span>
          )}
          <span
            onClick={() => clearSharedFilter()}
            style={{
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: selectedTags.length === 0 ? "var(--bg-selected)" : "none",
              color: selectedTags.length === 0 ? "var(--text)" : "var(--text-muted)",
            }}
          >{t("sm.allTags")}</span>
          <span
            onClick={() => setArchivedOnly((v) => !v)}
            style={{
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: archivedOnly ? ensureReadability("#8b5cf6") : "none",
              color: archivedOnly ? "#fff" : "var(--text-muted)",
              border: `1px solid ${archivedOnly ? ensureReadability("#8b5cf6") : "var(--border)"}`,
            }}
          >{`${t("sm.archived")}${archivedCount ? " " + archivedCount : ""}`}</span>
          <span
            onClick={() => setFavOnly((v) => !v)}
            style={{
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: favOnly ? ensureReadability("#d97706") : "none",
              color: favOnly ? "#fff" : "var(--text-muted)",
              border: `1px solid ${favOnly ? ensureReadability("#d97706") : "var(--border)"}`,
            }}
          >{`${t("sm.favorite")}`}</span>
          {data.tags.filter((n: any) => !n.parentId || !byId.has(n.parentId))
            .sort((a: any, b: any) => a.name.localeCompare(b.name))
            .flatMap((root: any) => chipRow(root, 0))}
          <button
            onClick={() => managerOpen.onOpen()}
            style={{ marginLeft: "auto", ...ghostBtn, fontSize: 10 } as React.CSSProperties}
          >{t("sm.manageTags")}</button>
        </div>
        {/* agent 过滤 chips：Pi 默认选中；已激活源点击切换显示/隐藏（§4.7 用户反馈：
            外部会话默认不显示，切换而非删除——去激活不在面板暴露） */}
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", padding: "5px 12px", borderBottom: "1px solid var(--border)", maxHeight: compact && scrunch === "brief" ? 52 : undefined, overflowY: compact && scrunch === "brief" ? "hidden" : undefined }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginRight: 2 }}>{t("sm.sourcesLabel")}</span>
          {[{ agent: "pi", label: "pi" }, ...(s.sources ?? []).filter((x: any) => x.status === "active" || x.status === "stale")].map((src: any) => {
            const m = AGENT_META[src.agent] ?? AGENT_META.default;
            const on = agentFilter.has(src.agent);
            return (
              <span
                key={src.agent}
                onClick={() => toggleAgentFilter(src.agent)}
                title={on ? `点击隐藏 ${src.label}` : `点击显示 ${src.label}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
                  color: on ? m.color : "var(--text-muted)",
                  background: on ? m.color + "1f" : "transparent",
                  border: `1px solid ${on ? m.color + "88" : "var(--border)"}`,
                }}
              >
                <span style={{ fontSize: 9, fontWeight: 700 }}>{m.short}</span>
                {src.label !== undefined && src.label !== src.agent ? src.label : ""}
                {(s.sources ?? []).find((x: any) => x.agent === src.agent)?.status === "stale" && (
                  <span style={{ color: ensureReadability("var(--warn, #f59e0b)") }} title={t("sm.sources.staleHint")}>⟳</span>
                )}
              </span>
            );
          })}
        </div>
        {/* M1: external source strip — discovered/stale cards (加载/同步入口) */}
        {(s.sources ?? []).some((x: any) => x.status === "discovered" || x.status === "stale") && (
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", padding: "5px 12px", borderBottom: "1px solid var(--border)", background: "rgba(16,185,129,0.04)" }}>
            {s.sources.filter((src: any) => src.status === "discovered" || src.status === "stale").map((src: any) => {
              const m = AGENT_META[src.agent] ?? AGENT_META.default;
              const busy = rowBusy.has("src:" + src.agent);
              const mk = (op: "activate" | "sync") => {
                if (busy) return;
                markBusy("src:" + src.agent);
                void sourceAction(op, src.agent).finally(() => markDone("src:" + src.agent));
              };
              return (
                <span
                  key={src.agent}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 9, fontSize: 10, border: "1px solid var(--border)", background: "var(--bg-panel)" }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "0 5px", borderRadius: 6, color: m.color, background: m.color + "1f", border: `1px solid ${m.color}55` }}>{m.short}</span>
                  <span style={{ color: "var(--text)", whiteSpace: "nowrap" }}>{src.label}</span>
                  {src.status === "discovered" && (
                    <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{t("sm.sources.found", { count: src.count })}<button onClick={() => mk("activate")} disabled={busy} style={{ ...miniBtn, color: ensureReadability("var(--ok, #22c55e)"), opacity: busy ? 0.7 : 1 }}>{busy ? t("sm.sources.loading") : t("sm.sources.load")}</button></span>
                  )}
                  {src.status === "stale" && (
                    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
                      <span style={{ color: ensureReadability("var(--warn, #f59e0b)"), whiteSpace: "nowrap" }}>{t("sm.sources.stale")}</span>
                      <button onClick={() => mk("sync")} disabled={busy} style={{ ...miniBtn, color: ensureReadability("var(--warn, #f59e0b)") }}>{busy ? t("sm.sources.loading") : t("sm.sources.sync")}</button>
                    </span>
                  )}
                  {src.status === "error" && (
                    <span style={{ color: ensureReadability("var(--danger, #f87171)"), cursor: "help" }} title={src.error ?? ""}>{t("sm.sources.error")}</span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {/* A16① 联合 tag 视图：选中 tag 时的关联文档（点行 openFile 右侧打开，related-docs 同款） */}
        {selectedTags.length > 0 && tagDocs.docs.length > 0 && (
          <div style={{ padding: "5px 12px", borderBottom: "1px solid var(--border)", background: "rgba(99,102,241,0.06)" }}>
            <span
              onClick={() => setTagDocs((p) => ({ ...p, open: !p.open }))}
              style={{ cursor: "pointer", fontSize: 10, color: "var(--text-muted)", display: "inline-flex", gap: 5, alignItems: "center" }}
              title={t("sm.tagDocsTip")}
            ><SIc name="fileText" size={11} /> {t("sm.tagDocs", { count: tagDocs.docs.length })}<span style={{ opacity: 0.6 }}>{tagDocs.open ? "▾" : "▸"}</span></span>
            {tagDocs.open && (
              <div style={{ marginTop: 4 }}>
                {tagDocs.docs.slice(0, 20).map((d) => (
                  <div
                    key={d.id}
                    onClick={() => openFile([d.root, d.relpath].filter(Boolean).join("/"), String(d.relpath || "").split("/").pop())}
                    style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "3px 4px", borderRadius: 5, cursor: "pointer" }}
                  >
                    <span style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{d.title}</span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{d.relpath}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* sections — content rendered one frame after the frame itself (T-1),
           and each list block is layout-isolated so row updates never reflow
           the whole dialog (T-2) */}
        <div style={{ padding: "8px 6px", ...(compact ? { contain: "layout style" } : { flex: 1, overflowY: "auto", contain: "layout style" }) }}>
          {filtered.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
              {agentFilter.size === 0 ? t("sm.agentFilter.empty") : t("sm.noResults")}
              {/* archived rows are hidden by default — surface them when they're
                 the only thing filtered out (empty list / search hits) */}
              {!archivedOnly && archivedCount > 0 && (
                <div
                  onClick={() => setArchivedOnly(true)}
                  style={{ marginTop: 6, cursor: "pointer", color: ensureReadability("#a78bfa"), fontSize: 11 }}
                >{t("sm.archivedHidden", { count: archivedCount })}</div>
              )}
            </div>
          )}
          {/* T-1: rows mounted in the second frame — the overlay + frame + header
             are already on screen, so the big list layout lands during the
             frame's opacity transition instead of blocking the open click. */}
          {!ready && filtered.length > 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>{t("sm.loading") ?? "…"}</div>}
          {ready && section("fav", t("sm.favorites"), favoritePage, favorites.length, () => setFavLoaded((n) => n + SECTION_PAGE_SIZE))}
          {ready && section("running", t("sm.running"), runningPage, runningList.length, () => setRunningLoaded((n) => n + SECTION_PAGE_SIZE))}
          {ready && section("recent", t("sm.recent"), pageItems, completed.length, null)}
        </div>
        </div>
        {/* pagination */}
        {completed.length > PAGE_SIZE && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)" }}>
            <button disabled={pageClamped === 0} onClick={() => setPage(pageClamped - 1)} style={ghostBtn}>{t("sm.prev")}</button>
            <span>{t("sm.pageOf", { page: pageClamped + 1, pages })}</span>
            <button disabled={pageClamped >= pages - 1} onClick={() => setPage(pageClamped + 1)} style={ghostBtn}>{t("sm.next")}</button>
          </div>
        )}
      </div>
      {/* MoveDialogHost / RowMenuHost 已上提 entry.tsx dialogs slot 全局挂一次（dock/面板两面共用）；
          面板关闭时收起「⋮」菜单模块态，见上方 closeRowMenu effect */}
      {batchMoveOpen && <span onClick={(e) => e.stopPropagation()}><BatchMoveDialog ids={[...selection]} allSessions={store.sessions as any[]} onDone={() => { setBatchMoveOpen(false); setSelection(new Set()); }} onClose={() => setBatchMoveOpen(false)} /></span>}
      {archiveDialogIds && <span onClick={(e) => e.stopPropagation()}><ArchiveDialog ids={archiveDialogIds} onClose={() => { setArchiveDialogIds(null); setSelection(new Set()); refreshArchStatus(); /* 列表对齐在各行动作内（refreshListChannels 全量+scoped+notify 一次打齐），此处不再重复拉 */ }} /></span>}
    </div>
  );
}

/** 右栏 dock face（DockBody + embedded 面板）——薄壳拆分（§5.1）后随本懒 chunk 走，
 *  entry 只注册 useGate 门控的懒包装，首屏不加载本 chunk。 */
export function PanelDockFace(props: any) {
  return (
    <DockBody itemKey={SM_PANEL_KEY} zone="right-panel" title="All Sessions" chrome="tab" zones={["right-panel"]}>
      <SessionsPanel {...props} embedded />
    </DockBody>
  );
}

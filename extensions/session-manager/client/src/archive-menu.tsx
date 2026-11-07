/**
 * ArchiveMenu + ArchiveMenuHost — 单一「📦」按钮 → 常驻弹层展开 4 选项。
 * 面板（sessions-panel.tsx）与侧栏（topbar.tsx RowActions）共用。
 *
 * 采用与 tag-ui.tsx TagEditPopover/TagPopoverHost 相同的「模块级状态 + 常驻宿主」模式：
 *   - ArchiveMenu（行内触发按钮）：状态存模块级，可随行 hover 卸载（侧栏行 hover 离开不影响弹层）；
 *   - ArchiveMenuHost（dialogs slot 挂一份的常驻宿主）：渲染位置 fixed 的 4 选项弹层，行卸载/hover 离开都不断。
 *
 * 4 选项（复刻原 ArchiveDialog 逻辑）：
 *   L1/L2  resolved/unresolved → act("assign", {sessionId, path: 已解决/未解决}) → archiveSession(id)
 *   L3     direct              → archiveSession(id)
 *   L4     delete              → deleteLiveSession(id)（live 文件直接删，confirm）
 *
 * 子会话处理（subagents/forks / 外部子代理）：
 *   主会话有子会话（store 里 parentSessionId 指向它的会话）时，点主菜单某项不再弹「单选+确定」，
 *   而是就地展开二级子菜单，两个按钮直接执行——「同时处理（连同主会话，先子后主）」或
 *   「只处理主会话（子会话保留/重挂上层）」，少一次点击。
 *   ext 行（zcode/cursor 等）的「从列表移除」不套二级子菜单（一个主项配子菜单太绕）：
 *   有子会话 → 主菜单直接平铺「同时移除 N 个子会话 / 只移除主会话」两项（子会话保留
 *   列表）——避免移除主会话后子会话在列表变孤儿；无子会话 → 单项「从列表移除」。
 *   两种形态之后都平铺「真归档」项（仅当该源在 store.extArchiveAgents 能力名单里——
 *   名单由服务端按 adapter 是否实现 snapshot/removeSession/putBack 下发，旧服务端无名单
 *   则不做限制）。兄弟项一律包进 Fragment，绝不用 `+` 相加 JSX 元素
 *   （React 元素是对象，相加得到 "[object Object][object Object]"——2026-09-21 qoder 行实测）。
 */
import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { t } from "./host-shim";
import { act, archiveSessions, archiveExtSession, deleteLiveSession, hideExtSession, collectSubtreeIds, useStore, markPendingRemoval, clearPendingRemoval } from "./store";
import { showConfirm } from "./confirm-dialog";
import { ensureReadability, SIc } from "./helpers";

type Mode = "resolved" | "unresolved" | "direct" | "delete";
/* 内容自适应宽度：弹层容器 width:auto 贴合内容（不再固定 172/224，避免手机上近半屏宽 + 右侧大片空白）；
   以下常量仅作定位防溢出估算：MENU_EST/SUB_EST 略大于实际内容宽（≈118/≈150，留余量），
   主菜单实际渲染宽度由 boxRef 实测（menuW）供二级子菜单位置精确计算。 */
const MENU_EST = 124;
const SUB_EST = 176;
const MENU_MIN = 120;
const SUB_MIN = 154;
const ITEM_H = 32;
const GAP = 2;

/* ── 模块级弹层状态（单实例，同 tag-ui tagPopoverState 模式）── */
const archiveMenuState = {
  open: null as null | { sessionId: string; top: number; left: number },
  subs: new Set<() => void>(),
};
export function closeArchiveMenu() {
  archiveMenuState.open = null;
  for (const l of archiveMenuState.subs) l();
}
/** 命令式打开（topbar 薄触发用）：懒加载方传入触发元素，取 rect 后与组件内 onClick 同路径。
 *  el 为 null（React 合成事件在异步回调里 currentTarget 已置空）时静默返回，不抛异常。 */
export function openArchiveMenuAt(sessionId: string, el: HTMLElement | null) {
  if (!el) return;
  openArchiveMenu(sessionId, el.getBoundingClientRect());
}
function openArchiveMenu(sessionId: string, rect: DOMRect) {
  const W = MENU_EST;
  let left = rect.right - W;
  if (left < 8) left = 8;
  if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
  let top = rect.bottom + 4;
  const H = ITEM_H * 4 + GAP * 3 + 8;
  if (top + H > window.innerHeight - 8) top = Math.max(8, rect.top - H - 4);
  archiveMenuState.open = { sessionId, top, left };
  for (const l of archiveMenuState.subs) l();
}

/* ── 二级子菜单状态（有子会话时展开；同 tag 模式模块级单实例）── */
const subMenuState = {
  mode: null as Mode | null,
  subs: new Set<() => void>(),
};
function openSubMenu(mode: Mode) {
  subMenuState.mode = mode;
  for (const l of subMenuState.subs) l();
}
function closeSubMenu() {
  subMenuState.mode = null;
  for (const l of subMenuState.subs) l();
}

/** 行内 📦 触发按钮（状态在模块级，可安全随行 hover 卸载）。 */
export function ArchiveMenu({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(archiveMenuState.open?.sessionId === sessionId);
  useEffect(() => {
    const l = () => setOpen(archiveMenuState.open?.sessionId === sessionId);
    archiveMenuState.subs.add(l);
    return () => { archiveMenuState.subs.delete(l); };
  }, [sessionId]);
  return (
    <button
      title={t("sm.archive")}
      data-archive-menu-trigger="1"
      onClick={(e) => {
        e.stopPropagation();
        if (archiveMenuState.open?.sessionId === sessionId) { closeArchiveMenu(); return; }
        openArchiveMenu(sessionId, e.currentTarget.getBoundingClientRect());
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 32, height: 32, padding: 0, flexShrink: 0, fontSize: 13,
        background: open ? "var(--bg-hover)" : "var(--bg-hover)",
        border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer",
        color: open ? "var(--text)" : "var(--text-muted)",
      }}
    ><SIc name="archive" size={14} /></button>
  );
}

/** 常驻弹层宿主（dialogs slot 挂一份）：行卸载/hover 离开都不影响弹层。 */
export function ArchiveMenuHost() {
  const [open, setOpen] = useState(archiveMenuState.open);
  const [sub, setSub] = useState(subMenuState.mode);
  const boxRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [menuW, setMenuW] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const store = useStore();
  useEffect(() => {
    const l = () => setOpen(archiveMenuState.open);
    archiveMenuState.subs.add(l);
    return () => { archiveMenuState.subs.delete(l); };
  }, []);
  useEffect(() => {
    const l = () => setSub(subMenuState.mode);
    subMenuState.subs.add(l);
    return () => { subMenuState.subs.delete(l); };
  }, []);
  // 打开后实测主菜单渲染宽度（内容自适应，供二级子菜单位置精确对齐）
  useEffect(() => {
    if (open && boxRef.current) setMenuW(Math.round(boxRef.current.getBoundingClientRect().width) || 0);
  }, [open]);
  // 点击外部关闭：主菜单/子菜单内部与 📦 触发按钮（保 toggle 语义）放行。
  useEffect(() => {
    if (!open && !sub) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (boxRef.current?.contains(n)) return;
      if (subRef.current?.contains(n)) return;
      if (n instanceof Element && n.closest("[data-archive-menu-trigger]")) return;
      closeArchiveMenu();
      closeSubMenu();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, sub]);
  if (!open) return null;

  // ext 源行（zcode/cursor 等只读镜像行，agent 非 pi）：归档管线只认 pi 会话文件，
  // 对这些行走归档必然 skipped 报错——菜单替换为「从列表移除」（视图层归档，源数据不动）。
  const openRow = [...(store.sessions ?? []), ...(store.archived ?? [])]
    .find((r) => String((r as { id?: unknown }).id) === open.sessionId) as { agent?: string } | undefined;
  const isExtRow = !!openRow?.agent && openRow.agent !== "pi";

  // 该会话是否有子会话（subagents/forks）：渲染期算一次，决定 › 显示与 hover 展开
  const childIds = collectSubtreeIds(store.sessions, open.sessionId);
  const hasKids = childIds.length > 0;

  // 「真归档」按源能力显隐：名单来自服务端（lib/agents/registry.archiveCapableAgents ——
  // 实现了 snapshot/removeSession/putBack 的内置 adapter），随 /sessions 全量下发。
  // 名单缺席/为空 = 旧服务端或未就绪，不做限制（照旧显示，点击后由服务端守卫报错）。
  const capList = store.extArchiveAgents;
  const canTrueArchive = !Array.isArray(capList) || capList.length === 0
    || capList.includes(String(openRow?.agent));

  /** 实际执行：children-first（叶子优先）先处理子会话，再处理主会话。 */
  const doRun = async (sessionId: string, mode: Mode, childIds: string[], together: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    // 涉及的行 id（含子会话）——执行即置灰标注（后台刷新慢，让用户知道在动），
    // 失败 clear 恢复样式；成功不 clear，等 refreshSessions 落地后 prune 自动清。
    const involved = together && childIds.length ? [sessionId, ...childIds] : [sessionId];
    for (const id of involved) markPendingRemoval(id, "live");
    const fail = () => { for (const id of involved) clearPendingRemoval(id); };
    try {
      if (mode === "delete") {
        if (together && childIds.length) {
          // 先删子会话（叶子优先，core 重挂扫描已无可挂子级）
          for (const cid of childIds) {
            const e = await deleteLiveSession(cid);
            if (e) { fail(); setErr(`${t("sm.deleteFailed") ?? "删除失败"}：${e}`); return; }
          }
        }
        const e = await deleteLiveSession(sessionId);
        if (e) { fail(); setErr(`${t("sm.deleteFailed") ?? "删除失败"}：${e}`); return; }
      } else {
        if (mode === "resolved" || mode === "unresolved") {
          const tagPath = mode === "resolved" ? t("sm.archiveTagResolved") : t("sm.archiveTagUnresolved");
          const ok = await act("assign", { sessionId, path: tagPath });
          if (!ok) { fail(); setErr(`${sessionId.slice(0, 8)} tag 失败`); return; }
        }
        const ids = together && childIds.length ? [sessionId, ...childIds] : [sessionId];
        const r = await archiveSessions(ids);
        if (!r.ok) {
          fail();
          // 全部被守卫跳过：区分「会话在打开/运行中（或未被索引）」与真实失败，避免误导
          setErr(r.skippedIds.length
            ? `${sessionId.slice(0, 8)} 无法归档：会话正在打开/运行中（或未被索引），请先关闭页面或等待结束`
            : `${sessionId.slice(0, 8)} 归档失败`);
          return;
        }
      }
      closeArchiveMenu();
      closeSubMenu();
    } finally {
      setBusy(false);
    }
  };

  const run = async (mode: Mode) => {
    if (busy || !open) return;
    setErr(null);
    // 有子会话（subagents/forks）→ 就地展开二级子菜单；无子会话直接执行
    // hover 已展开（sub === mode）时点击保持展开（不 toggle 关闭，避免点文字反而收起）
    if (hasKids) {
      openSubMenu(mode);
      return;
    }
    // 无子会话：删除走自绘确认弹窗（不再用浏览器原生 confirm）；归档直接执行
    if (mode === "delete") {
      showConfirm({
        title: t("sm.deleteTitle") ?? "彻底删除",
        message: t("sm.confirmDeleteLive") ?? "彻底删除该会话文件？删后不可恢复；运行中的 agent 会先停止。",
        confirmLabel: t("sm.archiveDelete") ?? "彻底删除",
        danger: true,
        onConfirm: () => doRun(open.sessionId, mode, [], false),
      });
      return;
    }
    await doRun(open.sessionId, mode, [], false);
  };

  /** ext 行执行：视图层移除（收进归档分组，源数据不动，可随时恢复接管）。
   *  ids 为要移除的行集合——「同时移除」= 主 + 全部子会话（先子后主，与 pi 归档
   *  同序）；「只移除自己」= [主]。无删除入口：外部行不可彻底删除（服务端同样
   *  拒绝），数据主权在源应用。 */
  const extRun = async (ids: string[]) => {
    if (busy || !open) return;
    setErr(null);
    setBusy(true);
    const involved = ids.length ? ids : [open.sessionId];
    for (const id of involved) markPendingRemoval(id, "live");
    const fail = () => { for (const id of involved) clearPendingRemoval(id); };
    try {
      for (const id of involved) {
        const ok = await hideExtSession(id, true);
        if (!ok) { fail(); setErr(`${id.slice(0, 8)} 移除失败`); return; }
      }
      closeArchiveMenu();
      closeSubMenu();
    } finally { setBusy(false); }
  };

  /** A03 真归档：源数据收进 .pwarc 归档库并从源应用移除（可 ext-restore 放回）。
   *  失败原因如实透出（运行中/不可解析/不支持 remove 等服务端判定）。 */
  const extArchive = async (id: string) => {
    if (busy || !open) return;
    setErr(null);
    setBusy(true);
    markPendingRemoval(id, "live");
    try {
      const r = await archiveExtSession(id);
      if (!r.ok) { clearPendingRemoval(id); setErr(`${id.slice(0, 8)} 真归档失败：${r.error ?? "?"}`); return; }
      closeArchiveMenu();
      closeSubMenu();
    } finally { setBusy(false); }
  };

  const item = (mode: Mode, icon: ReactNode, label: string, color: string, danger: boolean) => (
    <button
      onClick={() => void run(mode)}
      disabled={busy}
      style={{
        display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 9px",
        fontSize: 11, border: "none", background: sub === mode ? "var(--bg-hover)" : "none", textAlign: "left", borderRadius: 6,
        cursor: busy ? "default" : "pointer", whiteSpace: "nowrap",
        color: danger ? ensureReadability("var(--danger, #f87171)") : "var(--text)", opacity: busy ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { if (!busy) { e.currentTarget.style.background = "var(--bg-hover)"; if (hasKids) openSubMenu(mode); } }}
      onMouseLeave={(e) => { if (sub !== mode) e.currentTarget.style.background = "none"; }}
    >
      <span style={{ display: "flex", alignItems: "center" }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hasKids && <span style={{ fontSize: 10, color, fontWeight: 700, opacity: 0.9 }}>{busy ? "…" : "›"}</span>}
    </button>
  );

  // 二级子菜单位置：紧贴主菜单右侧（放不下则左侧）——主菜单宽用实测 menuW，未测到用估算
  const mw = menuW || MENU_EST;
  const subLeft = open.left + mw + 4 + SUB_EST > window.innerWidth - 8
    ? Math.max(8, open.left - SUB_EST - 4)
    : open.left + mw + 4;
  const modeLabel = sub === "resolved" ? t("sm.archiveResolved")
    : sub === "unresolved" ? t("sm.archiveUnresolved")
    : sub === "direct" ? t("sm.archiveDirect")
    : sub === "delete" ? t("sm.archiveDelete")
    : "";
  const isDelete = sub === "delete";
  const count = childIds.length;

  return (
    <>
      <div
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed", top: open.top, left: open.left, zIndex: 2147483500,
          width: "auto", minWidth: MENU_MIN, background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 9, boxShadow: "0 8px 30px rgba(0,0,0,0.35)", padding: 4,
          display: "flex", flexDirection: "column", gap: GAP,
        }}
      >
        {isExtRow ? (
          <>
            {hasKids ? (
              <>
                {/* 带子会话的外部行：主菜单直接平铺两项（一个主项再配二级子菜单反而绕；
                    与 All Sessions ⋮ 菜单同语义） */}
                <button
                  onClick={() => void extRun([open.sessionId, ...childIds])}
                  disabled={busy}
                  title={t("sm.extRemoveTitle") ?? "收进已归档分组，列表不再显示；随时可恢复接管，ZCode 等应用内数据不受影响"}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "stretch", gap: 1,
                    width: "100%", padding: "6px 9px", fontSize: 11, border: "none", background: "none",
                    textAlign: "left", borderRadius: 6, cursor: busy ? "default" : "pointer",
                    color: "var(--text)", opacity: busy ? 0.5 : 1, whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontSize: 13 }}>🚫</span>
                    <span style={{ fontWeight: 700 }}>
                      {t("sm.extChildrenTogetherBtn", { count }) ?? `同时移除 ${count} 个子会话`}
                    </span>
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 20 }}>
                    {t("sm.extHintTogether") ?? "连同主会话一起移出列表（先子后主）"}
                  </span>
                </button>
                <button
                  onClick={() => void extRun([open.sessionId])}
                  disabled={busy}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "stretch", gap: 1,
                    width: "100%", padding: "6px 9px", fontSize: 11, border: "none", background: "none",
                    textAlign: "left", borderRadius: 6, cursor: busy ? "default" : "pointer",
                    color: "var(--text)", opacity: busy ? 0.5 : 1, whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontSize: 13 }}>🔒</span>
                    <span>
                      {t("sm.extChildrenKeepBtn") ?? "只移除主会话"}
                    </span>
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 20 }}>
                    {t("sm.extHintKeep") ?? "子会话保留在列表"}
                  </span>
                </button>
              </>
            ) : (
              <button
                onClick={() => void extRun([open.sessionId])}
                disabled={busy}
                title={t("sm.extRemoveTitle") ?? "收进已归档分组，列表不再显示；随时可恢复接管，ZCode 等应用内数据不受影响"}
                style={{
                  display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 9px",
                  fontSize: 11, border: "none", background: "none", textAlign: "left", borderRadius: 6,
                  cursor: busy ? "default" : "pointer", whiteSpace: "nowrap", color: "var(--text)", opacity: busy ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <span style={{ fontSize: 13 }}>🚫</span>
                <span style={{ flex: 1 }}>{t("sm.extRemove") ?? "从列表移除"}</span>
              </button>
            )}
            {canTrueArchive && (
              <button
                onClick={() => void extArchive(open.sessionId)}
                disabled={busy}
                title="源数据收进归档库（.pwarc）并从该应用移除；随时可放回原处（字节级还原）。运行中/不可解析的会话会被拒绝。"
                style={{
                  display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 9px",
                  fontSize: 11, border: "none", background: "none", textAlign: "left", borderRadius: 6,
                  cursor: busy ? "default" : "pointer", whiteSpace: "nowrap", color: ensureReadability("var(--warn, #f59e0b)"), opacity: busy ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <span style={{ fontSize: 13 }}>📦</span>
                <span style={{ flex: 1 }}>{t("sm.extTrueArchive") ?? "真归档（从源移除，可放回）"}</span>
              </button>
            )}
          </>
        ) : (
          <>
            {item("resolved", <SIc name="checkCircle" size={13} />, t("sm.archiveResolved") ?? "已解决归档", ensureReadability("var(--ok, #22c55e)"), false)}
            {item("unresolved", <SIc name="helpCircle" size={13} />, t("sm.archiveUnresolved") ?? "未解决归档", ensureReadability("#64748b"), false)}
            {item("direct", <SIc name="archive" size={13} />, t("sm.archiveDirect") ?? "直接归档", ensureReadability("var(--warn, #f59e0b)"), false)}
            {item("delete", <SIc name="trash" size={13} />, t("sm.archiveDelete") ?? "彻底删除", ensureReadability("var(--danger, #f87171)"), true)}
          </>
        )}
        {err && !sub && (
          <div style={{ padding: "5px 9px", borderRadius: 6, fontSize: 10, background: "rgba(239,68,68,0.08)", color: ensureReadability("var(--danger, #f87171)") }}>{err}</div>
        )}
      </div>

      {sub && (
        <div
          ref={subRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: open.top, left: subLeft, zIndex: 2147483502,
            width: "auto", minWidth: SUB_MIN, background: "var(--bg-panel)", border: "1px solid var(--border)",
            borderRadius: 9, boxShadow: "0 8px 30px rgba(0,0,0,0.35)", padding: 4,
            display: "flex", flexDirection: "column", gap: 2,
          }}
        >
          <div style={{ padding: "4px 9px 2px", fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {modeLabel} · {count} 个子会话
          </div>
          {/* 同时处理（默认推荐，放上面） */}
          <button
            onClick={() => void doRun(open.sessionId, sub, childIds, true)}
            disabled={busy}
            style={{
              display: "flex", width: "100%", padding: "6px 9px",
              fontSize: 11, border: "none", background: "none", textAlign: "left", borderRadius: 6,
              cursor: busy ? "default" : "pointer", color: isDelete ? ensureReadability("var(--danger, #f87171)") : "var(--text)",
              opacity: busy ? 0.5 : 1, flexDirection: "column", alignItems: "stretch", gap: 1,
            }}
            onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 13 }}>{isDelete ? "🗑️" : "📦"}</span>
              <span style={{ fontWeight: 700 }}>
                {isDelete
                  ? (t("sm.childrenTogetherBtnDelete", { count }) ?? `同时删除 ${count} 个子会话`)
                  : (t("sm.childrenTogetherBtnArchive", { count }) ?? `同时归档 ${count} 个子会话`)}
              </span>
            </span>
            <span style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 20 }}>
              {t("sm.childrenHintTogether") ?? "连同主会话，先子后主"}
            </span>
          </button>
          {/* 只处理主会话 */}
          <button
            onClick={() => void doRun(open.sessionId, sub, childIds, false)}
            disabled={busy}
            style={{
              display: "flex", flexDirection: "column", alignItems: "stretch", gap: 1,
              width: "100%", padding: "6px 9px", fontSize: 11, border: "none", background: "none",
              textAlign: "left", borderRadius: 6, cursor: busy ? "default" : "pointer",
              color: "var(--text)", opacity: busy ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 13 }}>🔒</span>
              <span>
                {isDelete
                  ? (t("sm.childrenKeepBtnDelete") ?? "只删除主会话")
                  : (t("sm.childrenKeepBtnArchive") ?? "只归档主会话")}
              </span>
            </span>
            <span style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 20 }}>
              {isDelete
                ? (t("sm.childrenHintKeepDelete") ?? "子会话重挂上层")
                : (t("sm.childrenHintKeepArchive") ?? "子会话保留")}
            </span>
          </button>
          {err && (
            <div style={{ padding: "5px 9px", borderRadius: 6, fontSize: 10, background: "rgba(239,68,68,0.08)", color: ensureReadability("var(--danger, #f87171)") }}>{err}</div>
          )}
        </div>
      )}
    </>
  );
}

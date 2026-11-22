/**
 * session-manager · 标签相关共享 UI（StarButton / TagEditPopover / TagPicker / TagChip）。
 * 自手写版迁移，交互一比一。
 */
import { useState, useEffect, useRef } from "react";
import { t } from "./host-shim";
import { store, useStore, act, actPut, EMPTY_TAGS, ensureTags } from "./store";
import { byIdMap, tagPath, sessionTagIds, descendantsLocal, inputStyle, ghostBtn, ensureReadability } from "./helpers";
import { useFeature } from "./features";

export function StarButton({ sessionId, onToggle }: { sessionId: string; onToggle: (on: boolean) => void }) {
  // feature 门控（index.ts behavior.favorite-icons，默认关）：关闭时行内不显示收藏图标，
  // 收藏操作走 tag 下拉「收藏」项（tag-ui TagPicker，始终可用）。extman 切换即时生效。
  const show = useFeature("behavior.favorite-icons");
  const s = useStore();
  const fav = !!s.tagData && s.tagData.favoriteIds.includes(sessionId);
  if (!show) return null;
  return (
    <button
      title={fav ? t("sm.unfavorite") : t("sm.favorite")}
      onClick={(e) => { e.stopPropagation(); onToggle(!fav); }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0,
        background: "none", border: "none", cursor: "pointer",
        color: fav ? ensureReadability("var(--warn, #f59e0b)") : "var(--text-muted)",
      }}
    >{fav ? "★" : "☆"}</button>
  );
}

export function TagChip({ tagId, data, onClick, onRemove }: {
  tagId: string; data: any; onClick?: () => void; onRemove?: () => void;
}) {
  const node = byIdMap(data).get(tagId);
  if (!node) return null;
  return (
    <span
      title={tagPath(tagId, data)}
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "1px 7px", borderRadius: 9, fontSize: 10, lineHeight: "15px",
        background: node.color + "26", color: ensureReadability(node.color),
        border: `1px solid ${node.color}55`, cursor: onClick ? "pointer" : "default",
        whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
      }}
    >
      {node.name}
      {onRemove && (
        <span
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ cursor: "pointer", opacity: 0.8, marginLeft: 2 }}
        >×</span>
      )}
    </span>
  );
}

/** "选择或输入" picker: browsable tag tree + search + new-path input (§3.4).
 *  sessionId 可选：传入时顶部渲染「★ 收藏/取消收藏」行（tag 下拉里一起处理收藏，
 *  不依赖 behavior.favorite-icons feature——收藏操作入口始终可用）。 */
export function TagPicker({ onPick, onClose, position, sessionId }: {
  onPick: (tagId: string) => void; onClose?: () => void; position?: { top: number; left: number }; sessionId?: string | null;
}) {
  const s = useStore();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [newPath, setNewPath] = useState("");
  const data = s.tagData ?? EMPTY_TAGS;
  const fav = !!sessionId && !!s.tagData && s.tagData.favoriteIds.includes(sessionId);
  const byId = byIdMap(data);
  const roots = data.tags.filter((n: any) => !n.parentId || !byId.has(n.parentId))
    .sort((a: any, b: any) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const usage = (nodeId: string) => {
    const set = new Set(descendantsLocal(nodeId, byId));
    return Object.values(data.sessionTags).filter((ids: any) => ids.some((x: string) => set.has(x))).length;
  };
  const visible = (node: any, depth: number): any[] => {
    const path = tagPath(node.id, data);
    if (q && !path.toLowerCase().includes(q.toLowerCase())) return [];
    const children = data.tags.filter((n: any) => n.parentId === node.id)
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    const isCollapsed = collapsed.has(node.id);
    return [
      (
        <div
          key={node.id}
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 4px 3px " + (4 + depth * 14) + "px", fontSize: 11, borderRadius: 5 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
        >
          {children.length > 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); setCollapsed((prev) => { const n = new Set(prev); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); }}
              style={{ cursor: "pointer", width: 12, textAlign: "center", color: "var(--text-dim)", flexShrink: 0 }}
            >{isCollapsed ? "▸" : "▾"}</span>
          )}
          {children.length === 0 && <span style={{ width: 12, flexShrink: 0 }} />}
          <span style={{ width: 9, height: 9, borderRadius: 3, background: node.color, flexShrink: 0 }} />
          <span
            onClick={() => onPick(node.id)}
            style={{ cursor: "pointer", color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
            title={path}
          >{path}</span>
          <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{usage(node.id)}</span>
        </div>
      ),
      ...(!isCollapsed ? children.flatMap((c: any) => visible(c, depth + 1)) : []),
    ];
  };
  const createNew = async () => {
    const path = newPath.trim();
    if (!path) return;
    // create via a throwaway assign marker then drop the mapping (server-side action keeps it simple)
    const ok = await act("assign", { sessionId: "__picker", path });
    if (ok && store.tagData) {
      const leaf = (store.tagData.sessionTags.__picker ?? [])[0];
      const d = { ...store.tagData, sessionTags: { ...store.tagData.sessionTags } };
      delete d.sessionTags.__picker;
      await actPut(d);
      setNewPath("");
      if (leaf) onPick(leaf);
    }
  };
  const box: Record<string, string | number> = position
    ? { position: "fixed", top: position.top, left: position.left, zIndex: 410, width: 240, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 18px rgba(0,0,0,0.25)" }
    : { display: "flex", flexDirection: "column", gap: 4, marginTop: 4, borderTop: "1px solid var(--border)", paddingTop: 4 };
  return (
    <div style={box} onClick={(e) => e.stopPropagation()}>
      <input
        value={q}
        placeholder={t("sm.searchPlaceholder")}
        onChange={(e) => setQ(e.target.value)}
        style={inputStyle}
      />
      {sessionId && (
        <div
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          onClick={() => {
            void act(fav ? "unfavorite" : "favorite", { sessionId });
            onClose?.();
          }}
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", borderRadius: 5,
            cursor: "pointer", fontSize: 11,
            color: fav ? ensureReadability("#d97706") : "var(--text)",
            borderBottom: "1px solid var(--border)", marginBottom: 2,
          }}
        >{fav ? "★" : "☆"}<span>{fav ? t("sm.unfavorite") : t("sm.favorite")}</span></div>
      )}
      <div style={{ maxHeight: 200, overflowY: "auto" }}>
        {roots.map((r: any) => visible(r, 0))}
        {data.tags.length === 0 && <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("sm.noSessions")}</div>}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          value={newPath}
          placeholder={t("sm.tagPlaceholder")}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void createNew(); }}
          style={{ ...inputStyle, flex: 1 } as React.CSSProperties}
        />
        <button onClick={() => void createNew()} style={{ ...ghostBtn, background: "var(--accent)", color: "#fff", border: "none" }}>{t("sm.newTag")}</button>
      </div>
    </div>
  );
}


/** 模块级弹层状态（单实例，同 sessions-panel extViewerState 模式）。
 *  侧栏行 hover 卸载不会丢状态——弹层由常驻的 TagPopoverHost 渲染。 */
const tagPopoverState = {
  open: null as null | { sessionId: string; top: number; left: number },
  subs: new Set<() => void>(),
};
export function closeTagPopover() {
  tagPopoverState.open = null;
  for (const l of tagPopoverState.subs) l();
}
function openTagPopover(sessionId: string, rect: DOMRect) {
  tagPopoverState.open = { sessionId, top: rect.bottom + 4, left: Math.max(8, rect.right - 260) };
  for (const l of tagPopoverState.subs) l();
}

/** 行内触发按钮（可安全随行 hover 卸载——状态在模块级）。
 *  「#」展示状态：有 tag → tag 色；无 tag 但有收藏 → 收藏黄（收藏图标默认关，
 *  收藏状态靠 # 体现）；既无 tag 也无收藏 → 默认灰。tag 优先于收藏。 */
export function TagEditPopover({ sessionId }: { sessionId: string }) {
  const s = useStore();
  const data = s.tagData ?? EMPTY_TAGS;
  const tagIds = sessionTagIds(sessionId, data);
  const fav = !!s.tagData && data.favoriteIds.includes(sessionId);
  const favColor = ensureReadability("#d97706");
  return (
    <button
      title={t("sm.addTag")}
      data-tag-popover-trigger="1"
      onClick={(e) => {
        e.stopPropagation();
        if (tagPopoverState.open?.sessionId === sessionId) { closeTagPopover(); return; }
        openTagPopover(sessionId, e.currentTarget.getBoundingClientRect());
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0,
        background: "none", border: "none", cursor: "pointer",
        color: tagIds.length ? "var(--accent)" : (fav ? favColor : "var(--text-dim)"), fontSize: 13,
      }}
    >#</button>
  );
}

/** SessionSidebar 行内 meta（sessionRowMeta slot；排在 aiti-plan-first 方案标之后，
 *  顺序由扩展发现序=字典序注册顺序保证，见 entry.tsx 注释）：会话 tag 小胶囊，
 *  最多 2 个 + 溢出计数。点击弹出该会话的 tag 管理菜单（复用 openTagPopover →
 *  TagPopoverHost 常驻弹层；带 data-tag-popover-trigger 保 toggle/外部点击放行语义）。
 *  数据新鲜度：由 event-bus 帧（sm:tags-changed）驱动刷新（entry.tsx 常驻订阅），
 *  这里仅在 tagData 尚未拉取时懒加载补拉一次（ensureTags 只首次发请求）。 */
export function SidebarRowTags(props: any) {
  const s = useStore();
  const sid = String(props?.currentSession?.id || "");
  useEffect(() => { void ensureTags(); }, []);
  if (!sid) return null;
  const data = s.tagData ?? EMPTY_TAGS;
  const ids = sessionTagIds(sid, data);
  if (!ids.length) return null;
  const byId = byIdMap(data);
  const shown = ids.slice(0, 2);
  const rest = ids.length - shown.length;
  const openMenu = (e: any) => {
    e.stopPropagation(); // 不触发行点击（切会话）
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (tagPopoverState.open?.sessionId === sid) { closeTagPopover(); return; }
    openTagPopover(sid, rect);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 1, minWidth: 0, overflow: "hidden" }}>
      {shown.map((id: string) => {
        const node = byId.get(id);
        if (!node) return null;
        return (
          <span
            key={id}
            title={tagPath(id, data)}
            data-tag-popover-trigger="1"
            onClick={openMenu}
            style={{
              flexShrink: 0, fontSize: 9, lineHeight: "14px", whiteSpace: "nowrap",
              maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis",
              cursor: "pointer", color: ensureReadability(node.color),
              background: node.color + "26", border: `1px solid ${node.color}55`,
              borderRadius: 999, padding: "0 5px",
            }}
          >{node.name}</span>
        );
      })}
      {rest > 0 && (
        <span
          title={ids.map((id: string) => tagPath(id, data)).join("\n")}
          data-tag-popover-trigger="1"
          onClick={openMenu}
          style={{ flexShrink: 0, fontSize: 9, lineHeight: "14px", cursor: "pointer", color: "var(--text-dim)" }}
        >+{rest}</span>
      )}
    </span>
  );
}

/** 常驻弹层宿主（dialogs slot 挂一份）：行卸载/hover 离开都不影响弹层。 */
export function TagPopoverHost() {
  const s = useStore();
  const [open, setOpen] = useState(tagPopoverState.open);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const l = () => setOpen(tagPopoverState.open);
    tagPopoverState.subs.add(l);
    return () => { tagPopoverState.subs.delete(l); };
  }, []);
  // 点击外部关闭（同 TopbarTags 编辑器机制）：弹层内部与 # 触发按钮（保 toggle 语义）放行。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (boxRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-tag-popover-trigger]")) return;
      closeTagPopover();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);
  if (!open) return null;
  const data = s.tagData ?? EMPTY_TAGS;
  const tagIds = sessionTagIds(open.sessionId, data);
  return (
    <div
      ref={boxRef}
      style={{
        position: "fixed", top: open.top, left: open.left, zIndex: 400,
        display: "flex", flexDirection: "column", gap: 4, padding: 6,
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
        boxShadow: "0 6px 18px rgba(0,0,0,0.25)", width: 260,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* current tags on this session (removable) */}
      {tagIds.map((tid) => (
        <TagChip
          key={tid} tagId={tid} data={data}
          onRemove={() => void act("unassign", { sessionId: open.sessionId, tagId: tid })}
        />
      ))}
      {/* §4.1 (user req): the picker opens automatically — pick an existing
         tag from the tree, or type a new path below. */}
      <TagPicker
        sessionId={open.sessionId}
        onClose={closeTagPopover}
        onPick={(tagId) => { void act("assignTag", { sessionId: open.sessionId, tagId }); closeTagPopover(); }}
      />
    </div>
  );
}

/**
 * session-manager · 会话顶栏标签 widget（sessionTopbar slot）+ 侧栏行内动作（sessionRowActions slot）。
 * 自手写版迁移，交互一比一（含 §3.4 pending tags 持久化/合并、自动补全、点击外部关闭）。
 */
import { useState, useEffect, useRef } from "react";
import { t } from "./host-shim";
import {
  store, useStore, managerOpen, act,
  ensureTags,
  loadPendingMap, savePendingMap, toggleSharedFilter,
  EMPTY_TAGS,
} from "./store";
import { byIdMap, tagPath, sessionTagIds } from "./helpers";
import { TagChip, TagPicker, TagEditPopover } from "./tag-ui";
// 薄壳拆分（§5.1）：archive-menu 弹层在懒 chunk——触发按钮轻量自绘（视觉与 archive-menu
// 版本一致），点击时 import 懒 chunk 再 openArchiveMenuAt（同 rect 语义）。
const archiveChunk = () => import("./archive-menu");
function ArchiveMenuLazy({ sessionId }: { sessionId: string }) {
  return (
    <button
      title={t("sm.archive")}
      data-archive-menu-trigger="1"
      onClick={(e) => {
        e.stopPropagation();
        // 同步捕获触发元素：React 合成事件 handler 返回后 currentTarget 置 null，异步回调里访问会崩。
        const trigger = e.currentTarget;
        void archiveChunk().then((m) => m.openArchiveMenuAt(sessionId, trigger));
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 32, height: 32, padding: 0, flexShrink: 0, fontSize: 13,
        background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 7,
        cursor: "pointer", color: "var(--text-muted)",
      }}
    >📦</button>
  );
}
import { useFeature } from "./features";

export function TopbarTags(props: any) {
  const s = useStore();
  // 懒加载：首次展示当前会话 tag chip 需要词典才拉（后续变更由 event-bus 帧驱动，
  // 见 entry.tsx 常驻订阅 + onTagsChangedFrame；不再因切会话/回前台/focus 重复拉取）。
  useEffect(() => { void ensureTags(); }, []);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<{ id: string; path: string }[]>([]);
  const [pickPos, setPickPos] = useState<{ top: number; left: number } | null>(null); // fixed-position picker popover
  const editRef = useRef<HTMLSpanElement>(null); // 编辑器容器（输入框/建议/TagPicker 弹层）——点击外部才关闭
  // 点击编辑区外关闭。不能依赖输入框 onBlur：真实点击标签树行/搜索框时浏览器先移焦 → blur →
  // 编辑器整体卸载（菜单先消失），click 事件到不了标签行，标签选不上。改用 document mousedown
  // 判断目标是否在编辑器内：内部点击（选标签/搜索/▦/⚙/新建）一律不关，外部点击才关。
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (editRef.current && editRef.current.contains(e.target as Node)) return;
      setEditing(false); setSuggestions([]); setPickPos(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [editing]);
  const session = props.currentSession;
  const newSessionCwd = props.newSessionCwd ?? null;
  const isNewSession = !session && !!newSessionCwd;
  const data = s.tagData ?? EMPTY_TAGS;
  const fav = session && data.favoriteIds.includes(session.id);
  // feature 门控（behavior.favorite-icons，默认关）：关闭时顶栏标签区不显示收藏按钮，
  // 收藏操作走标签编辑器的 TagPicker「收藏」行（始终可用）。
  const showFavIcon = useFeature("behavior.favorite-icons");
  const tagIds: string[] = session ? sessionTagIds(session.id, data) : [];

  // §3.4: 新会话 tag 落 localStorage（按 cwd）——刷新/重挂载不丢；会话创建（含刷新恢复）后合并。
  const [pending, setPending] = useState<string[]>(() => {
    const m = loadPendingMap();
    return newSessionCwd && Array.isArray(m[newSessionCwd]) ? m[newSessionCwd] : [];
  });
  // 切换新建会话的 cwd（未重挂载）→ 从存储重载该 cwd 的 pending
  const pendingKeyRef = useRef(newSessionCwd || "");
  const keySwitchingRef = useRef(false);
  useEffect(() => {
    const key = newSessionCwd || "";
    if (key === pendingKeyRef.current) return;
    pendingKeyRef.current = key;
    keySwitchingRef.current = true;
    const m = loadPendingMap();
    setPending(key && Array.isArray(m[key]) ? m[key] : []);
  }, [newSessionCwd]);
  // pending 变更 → 落盘（切换 cwd 的那一帧跳过，避免把旧 cwd 的 pending 写到新 cwd）
  useEffect(() => {
    if (keySwitchingRef.current) { keySwitchingRef.current = false; return; }
    const m = loadPendingMap();
    const key = pendingKeyRef.current;
    if (key) {
      if (pending.length) m[key] = [...pending];
      else delete m[key];
    }
    savePendingMap(m);
  }, [pending]);
  // 合并：session 出现（新建 null→id，或刷新后直接恢复）→ 该 cwd 的 pending 附到 sessionId；
  //   全部成功才清存储（act 内部已有 409 重试）；同一 cwd 只合并一次。
  const mergedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = session?.id ?? null;
    if (!id) return;
    const cwd = session.cwd || null;
    if (!cwd || mergedCwdRef.current === cwd) return;
    mergedCwdRef.current = cwd;
    const m = loadPendingMap();
    const paths = Array.isArray(m[cwd]) ? m[cwd].slice() : [];
    if (!paths.length) return;
    setPending([]);
    void (async () => {
      let allOk = true;
      for (const p of paths) {
        try { if (!(await act("assign", { sessionId: id, path: p }))) allOk = false; } catch { allOk = false; }
      }
      if (allOk) {
        const m2 = loadPendingMap();
        delete m2[cwd];
        savePendingMap(m2);
      }
    })();
  }, [session?.id, session?.cwd]);

  // §3.4 autocomplete: suggest existing tag paths matching the input
  useEffect(() => {
    const q = input.trim().toLowerCase();
    if (!q || !editing) { setSuggestions([]); return; }
    const all = data.tags.map((n: any) => ({ id: n.id, path: tagPath(n.id, data) }))
      .filter((x) => x.path.toLowerCase().includes(q))
      .slice(0, 8);
    setSuggestions(all);
  }, [input, editing, data]);

  const commit = async () => {
    const path = input.trim();
    if (!path) return;
    if (isNewSession) {
      // §3.4 pending-new-session tags — not persisted until the session exists
      setPending((p) => [...p, path]);
      setInput("");
      setEditing(false);
    } else if (session) {
      const ok = await act("assign", { sessionId: session.id, path });
      if (ok) setInput("");
    }
  };

  const pickSuggestion = (path: string) => { setInput(path); setSuggestions([]); };

  // ⋯ 下拉（menu）模式：与其他菜单项统一为「36px 图标槽 + 右竖线」——不渲染完整 widget，
  // 点击打开标签管理器（顶栏/会话内仍是完整 tag widget）。位置在所有 hooks 之后。
  if (props?.menu === true) {
    return (
      <div
        role="button" tabIndex={0}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, flexShrink: 0, borderRight: "1px solid var(--border)", cursor: "pointer" }}
        onClick={() => managerOpen.onOpen()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); managerOpen.onOpen(); } }}
        title={t("sm.tags")}
      >
        <svg
          width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
          <path key="p1" d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42z" />
          <line key="p2" x1={7} y1={7} x2={7.01} y2={7} />
        </svg>
      </div>
    );
  }

  return (
    <span
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "0 8px", fontSize: 11, color: "var(--text-muted)",
        whiteSpace: "nowrap", overflow: "hidden", flexShrink: 0, position: "relative",
      }}
    >
      <span style={{ color: "var(--text-dim)", marginRight: 2 }}>{t("sm.tags")}</span>
      {session && showFavIcon && (
        <button
          title={fav ? t("sm.unfavorite") : t("sm.favorite")}
          onClick={() => void act(fav ? "unfavorite" : "favorite", { sessionId: session.id })}
          style={{ background: "none", border: "none", cursor: "pointer", color: fav ? "#f59e0b" : "var(--text-dim)", fontSize: 12, padding: 0 }}
        >{fav ? "★" : "☆"}</button>
      )}
      {/* §3.4: chips are clickable — add to the panel filter（上限 2 个 + 计数：窄顶栏行也能保持 tag 区可见） */}
      {(isNewSession ? pending : tagIds).slice(0, 2).map((tidOrPath) => {
        if (isNewSession) {
          return (
            <span
              key={tidOrPath}
              title={tidOrPath}
              style={{ padding: "1px 7px", borderRadius: 9, fontSize: 10, background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
            >{"⌛" + tidOrPath.split("/").pop()}</span>
          );
        }
        // §3.4: chips removable (×) + click adds to the panel filter
        return (
          <TagChip
            key={tidOrPath} tagId={tidOrPath} data={data}
            onClick={() => toggleSharedFilter(tidOrPath)}
            onRemove={() => void act("unassign", { sessionId: session.id, tagId: tidOrPath })}
          />
        );
      })}
      {(isNewSession ? pending : tagIds).length > 2 && (
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{`+${(isNewSession ? pending : tagIds).length - 2}`}</span>
      )}
      {isNewSession && <span style={{ fontSize: 10, color: "#f59e0b" }}>新建会话</span>}
      {editing ? (
        <span ref={editRef} style={{ position: "relative", display: "inline-flex" }}>
          <input
            autoFocus={true}
            value={input}
            placeholder={t("sm.tagPlaceholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") { setEditing(false); setSuggestions([]); setPickPos(null); }
            }}
            style={{ width: 130, fontSize: 10, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--bg)", color: "var(--text)", outline: "none" }}
          />
          {suggestions.length > 0 && (
            <div
              style={{
                position: "absolute", top: "calc(100% + 2px)", left: 0, zIndex: 320,
                background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 7,
                boxShadow: "0 6px 18px rgba(0,0,0,0.25)", overflow: "hidden", minWidth: 140,
              }}
            >
              {suggestions.map((sg) => (
                <div
                  key={sg.id}
                  onMouseDown={(e) => { e.preventDefault(); pickSuggestion(sg.path); }}
                  style={{
                    padding: "5px 10px", fontSize: 11, cursor: "pointer", color: "var(--text)",
                    fontFamily: "var(--font-mono)", background: "var(--bg)",
                  }}
                >{sg.path}</div>
              ))}
            </div>
          )}
          {/* §3.4: pick from the tag tree (选择) or keep typing (输入) */}
          <button
            title={t("sm.chooseTag")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPickPos({ top: r.bottom + 4, left: Math.max(8, r.right - 240) });
            }}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-dim)", fontSize: 12, padding: "0 3px",
            }}
          >▦</button>
          {/* §3.4: tag-manager entry from the editor */}
          <button
            title={t("sm.manageTags")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setEditing(false); managerOpen.onOpen(); }}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-dim)", fontSize: 11, padding: "0 3px",
            }}
          >⚙</button>
          {pickPos && (
            <TagPicker
              position={pickPos}
              sessionId={!isNewSession ? (session?.id ?? null) : null}
              onClose={() => setPickPos(null)}
              onPick={(tagId) => {
                // opened session → assign directly; new session → pending path
                if (isNewSession) {
                  const path = tagPath(tagId, data);
                  setPending((p) => (p.includes(path) ? p : [...p, path]));
                } else if (session) {
                  void act("assignTag", { sessionId: session.id, tagId });
                }
                setPickPos(null);
              }}
            />
          )}
        </span>
      ) : (
        <button
          title={t("sm.addTag")}
          onClick={(e) => {
            setEditing(true);
            // user req: the tag picker opens automatically with the editor
            const r = e.currentTarget.getBoundingClientRect();
            setPickPos({ top: r.bottom + 4, left: Math.max(8, r.right - 240) });
          }}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 13, padding: "0 2px" }}
        >+</button>
      )}
    </span>
  );
}

/* ═══════════ sessionRowActions: favorite star + inline tag edit + archive (§4.1) ═══════════ */

export function RowActions(props: any) {
  const s = useStore();
  useEffect(() => { void ensureTags(); }, []);
  const session = props.currentSession;
  if (!session) return null;
  const data = s.tagData ?? EMPTY_TAGS;
  const fav = !!s.tagData && data.favoriteIds.includes(session.id);
  // feature 门控（behavior.favorite-icons，默认关）：侧栏行收藏按钮同样隐藏，
  // 收藏操作走行内 #（TagEditPopover）弹层的「收藏」行。
  const showFavIcon = useFeature("behavior.favorite-icons");
  // feature 门控（behavior.session-timeline，默认关）：行悬停「⎇ 时间线」按钮默认不显示；
  // 打开时间线走 All Sessions 行「⋯」菜单（菜单展开面低频，长显不占行内空间，不接 feature）。
  const showTimelineBtn = useFeature("behavior.session-timeline");
  /* sidebar rows are live core sessions — running ones can't be archived (server enforces too) */
  const canArchive = !s.running.has(session.id);
  return (
    <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {showFavIcon && (
        <button
          title={fav ? t("sm.unfavorite") : t("sm.favorite")}
          onClick={(e) => { e.stopPropagation(); void act(fav ? "unfavorite" : "favorite", { sessionId: session.id }); }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 32, height: 32, padding: 0,
            background: "var(--bg-hover)", border: "1px solid var(--border)",
            borderRadius: 7, cursor: "pointer", flexShrink: 0,
            color: fav ? "#f59e0b" : "var(--text-muted)",
          }}
        >{fav ? "★" : "☆"}</button>
      )}
      {/* [P1-6 链③] All Sessions 行 → 时间线（复用 aiti-git-trace-open 通道，定 session 打开）；
          feature 门控（behavior.session-timeline，默认关）——菜单面入口见 sessions-panel 行「⋯」菜单 */}
      {showTimelineBtn && (
      <button
        title="打开该会话的时间线（aiti-git-trace）"
        onClick={(e) => {
          e.stopPropagation();
          try {
            window.dispatchEvent(new CustomEvent("aiti-git-trace-open", { detail: { kind: "timeline", data: { sessionId: session.id } } }));
          } catch { /* noop */ }
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 32, height: 32, padding: 0,
          background: "var(--bg-hover)", border: "1px solid var(--border)",
          borderRadius: 7, cursor: "pointer", flexShrink: 0,
          color: "var(--text-muted)",
        }}
      >⎇</button>
      )}
      <TagEditPopover sessionId={session.id} />
      {/* 单一 📦 ▾ → 原地展开 4 选项（已解决/未解决/直接/彻底删除）——已解决/未解决按名 assign；彻底删除走 deleteLiveSession */}
      {canArchive && <ArchiveMenuLazy sessionId={session.id} />}
    </span>
  );
}

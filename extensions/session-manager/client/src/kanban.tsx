/**
 * session-manager · 看板页（pages slot，tag 列 = 泳道）。
 * 自手写版迁移，交互一比一。
 */
import { useState, useEffect, useRef } from "react";
import { t } from "./host-shim";
import {
  store, useStore, kanbanOpen, refreshSessions, ensureTags,
  useSharedFilter, toggleSharedFilter, clearSharedFilter, displayCwd, EMPTY_TAGS,
} from "./store";
import { byIdMap, tagPath, sessionTagIds, matchesTags, sessionTitle, fmtRelative, descendantsLocal, selectStyle, ghostBtn, SIc } from "./helpers";
import { StarButton, TagEditPopover } from "./tag-ui";
import { openViewer } from "./store";
import { act } from "./store";

export function KanbanPage(props: any) {
  const s = useStore();
  const [open, setOpen] = useState(kanbanOpen.value);
  const [project, setProject] = useState<string | null>(null); // null = all projects
  const [columns, setColumns] = useState<string[]>([]); // tag ids as columns
  // §5.3.1 TagFilterBar: narrows sessions within columns (OR, tree-aware),
  // sharing the same tag set semantics as the columns.
  const filterTags = useSharedFilter();
  const [filterVisible, setFilterVisible] = useState(false);
  useEffect(() => {
    const l = () => setOpen(kanbanOpen.value);
    kanbanOpen.subs.add(l);
    return () => { kanbanOpen.subs.delete(l); };
  }, []);

  // refresh on open (external/multi-tab changes) — same fix as the panel
  useEffect(() => {
    if (!open) return;
    void refreshSessions();
    void ensureTags();
  }, [open]);

  // cross-view state: inherit the sidebar-selected project when it changes
  const syncedCwd = useRef<string | null>(null);
  useEffect(() => {
    const cwd = props.activeCwd ?? null;
    if (cwd && cwd !== syncedCwd.current) {
      syncedCwd.current = cwd;
      // resolve to projectRoot for grouping
      const match = s.sessions.find((x) => x.cwd === cwd);
      setProject(match?.projectRoot ?? cwd);
    }
  }, [props.activeCwd]);

  useEffect(() => {
    void refreshSessions();
    void ensureTags();
  }, []);

  // default columns = first 4 tags once loaded
  useEffect(() => {
    if (columns.length === 0 && s.tagData && s.tagData.tags.length > 0) {
      setColumns(s.tagData.tags.slice(0, Math.min(4, s.tagData.tags.length)).map((n: any) => n.id));
    }
  }, [s.tagData]);

  if (!open) return null;

  const data = s.tagData ?? EMPTY_TAGS;
  const byId = byIdMap(data);
  const projects = [...new Set(s.sessions.map((x: any) => x.projectRoot ?? x.cwd).filter(Boolean))]
    .sort((a: string, b: string) => a.localeCompare(b));
  const tagList = [...data.tags].sort((a: any, b: any) => a.name.localeCompare(b.name));

  const sessionsInProject = project
    ? s.sessions.filter((x: any) => (x.projectRoot ?? x.cwd) === project)
    : s.sessions;
  const narrowed = filterTags.length
    ? sessionsInProject.filter((x: any) => matchesTags(x.id, data, filterTags))
    : sessionsInProject;

  const sessionsOfColumn = (tagId: string) => {
    const set = new Set(descendantsLocal(tagId, byId));
    const list = narrowed.filter((x: any) => sessionTagIds(x.id, data).some((tid) => set.has(tid)));
    return list.sort((a: any, b: any) => {
      const ra = s.running.has(a.id) ? 0 : 1;
      const rb = s.running.has(b.id) ? 0 : 1;
      return ra - rb || (b.modified ?? "").localeCompare(a.modified ?? "");
    });
  };

  const card = (sess: any) => (
    <div
      key={sess.id}
      onClick={() => {
        if (sess.archived) openViewer(sess.id);
        else { props.onSelectSession?.(sess); kanbanOpen.onClose(); }
      }}
      style={{
        padding: "8px 10px", borderRadius: 9, cursor: "pointer",
        background: "var(--bg)", border: "1px solid var(--border)",
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: s.running.has(sess.id) ? "var(--accent)" : "var(--text-dim)" }}>
          {s.running.has(sess.id) ? "⟳" : sess.archived ? <SIc name="archive" size={11} /> : ""}
        </span>
        <span style={{ flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionTitle(sess)}</span>
        <StarButton
          sessionId={sess.id}
          onToggle={(on) => void act(on ? "favorite" : "unfavorite", { sessionId: sess.id })}
        />
        {/* 标签「#」：提供 always-可用收藏入口（TagPicker 收藏行）——feature behavior.favorite-icons
            关闭时行内星标隐藏，收藏仍可经此到达（kanban 卡无其它标签入口，靠它兜底）。 */}
        <TagEditPopover sessionId={sess.id} />
      </div>
      <div style={{ marginTop: 3, display: "flex", gap: 6, fontSize: 10, color: "var(--text-dim)" }}>
        {/* §5.3.1: in "All projects" mode the card shows the project path */}
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayCwd(project ? sess.cwd : (sess.projectRoot ?? sess.cwd))}
        </span>
        <span style={{ flexShrink: 0 }}>{fmtRelative(sess.modified)}</span>
      </div>
    </div>
  );

  const column = (tagId: string) => {
    const node = byId.get(tagId);
    if (!node) return null;
    const items = sessionsOfColumn(tagId);
    return (
      <div
        key={tagId}
        style={{
          width: 240, flexShrink: 0, maxHeight: "100%", overflowY: "auto",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 10, padding: 8, marginRight: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 2px 8px" }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: node.color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tagPath(tagId, data)}</span>
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{items.length}</span>
        </div>
        {items.length === 0
          ? <div style={{ padding: 10, textAlign: "center", color: "var(--text-dim)", fontSize: 11 }}>{t("sm.empty")}</div>
          : items.map(card)}
      </div>
    );
  };

  return (
    <div
      style={{
        position: "absolute", inset: 0, zIndex: 40,
        background: "var(--bg)", display: "flex", flexDirection: "column",
      }}
    >
      {/* toolbar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13, whiteSpace: "nowrap" }}>{t("sm.kanban")}</strong>
        <select
          value={project ?? ""}
          onChange={(e) => setProject(e.target.value || null)}
          style={selectStyle}
        >
          <option key="__all__" value="">{t("sm.allProjects")}</option>
          {projects.map((p) => <option key={p} value={p}>{displayCwd(p)}</option>)}
        </select>
        <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("sm.columns")}</span>
        {tagList.map((node: any) => (
          <span
            key={node.id}
            onClick={() => setColumns((prev) => prev.includes(node.id) ? prev.filter((x) => x !== node.id) : [...prev, node.id])}
            style={{
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: columns.includes(node.id) ? node.color + "33" : "none",
              color: columns.includes(node.id) ? node.color : "var(--text-dim)",
              border: `1px solid ${columns.includes(node.id) ? node.color : "var(--border)"}`,
            }}
          >{node.name}</span>
        ))}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={() => setFilterVisible((v) => !v)}
            style={{ ...ghostBtn, color: filterTags.length ? "var(--accent)" : "var(--text-muted)" } as React.CSSProperties}
          >{`${t("sm.filter")}${filterTags.length ? " " + filterTags.length : ""}`}</button>
          <button onClick={() => kanbanOpen.onClose()} aria-label={t("sm.close")} title={t("sm.close")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 } as React.CSSProperties}>✕</button>
        </span>
      </div>
      {/* §5.3.1 TagFilterBar — narrows sessions inside columns (OR, tree-aware) */}
      {filterVisible && (
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", padding: "5px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <span
            onClick={() => clearSharedFilter()}
            style={{
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: filterTags.length === 0 ? "var(--bg-selected)" : "none",
              color: filterTags.length === 0 ? "var(--text)" : "var(--text-muted)",
            }}
          >{t("sm.allTags")}</span>
          {tagList.map((node: any) => (
            <span
              key={node.id}
              onClick={() => toggleSharedFilter(node.id)}
              title={tagPath(node.id, data)}
              style={{
                padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
                background: filterTags.includes(node.id) ? node.color + "33" : node.color + "1a",
                color: node.color,
                border: `1px solid ${filterTags.includes(node.id) ? node.color : node.color + "33"}`,
              }}
            >{node.name}</span>
          ))}
        </div>
      )}
      {/* columns */}
      <div style={{ flex: 1, overflowX: "auto", display: "flex", alignItems: "flex-start", padding: "10px 8px" }}>
        {columns.map(column)}
        {columns.length === 0 && (
          <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 12 }}>{t("sm.noColumns")}</div>
        )}
      </div>
    </div>
  );
}

/**
 * session-manager client bundle — prebuilt ESM, ctx-based (no react import).
 *
 * Slots:
 *  - sidebar:    entry button + running-count badge → opens the panel
 *  - toolbar:    same entry (top bar)
 *  - dialogs:    SessionsPanel (flat all-sessions list) + TagManager (tree)
 *  - sessionTopbar: current session tag chips + favorite + add-tag
 *  - sessionRowActions: per-session favorite star
 *
 * Data: sessions/running from core /api/sessions + /api/agent/running; tag
 * data from the extension's own /api/extensions/session-manager/ endpoints.
 * Mutations go through server-side actions (optimistic version lock; 409 →
 * re-fetch + retry once).
 */

// 空标签数据兜底（稳定引用——useEffect 依赖比较用;若用对象字面量,
// 每次渲染都生成新对象导致依赖每次都变 → setState 循环 → Maximum update depth exceeded）
const EMPTY_TAGS = Object.freeze({ version: 0, favoriteIds: [], tags: [], sessionTags: {} });

// Keyframes for the panel open fade (T-2): injected once per document.
// A compositor-only opacity animation — opening the dialog never forces a
// synchronous layout of the (potentially large) session list tree.
(function ensurePanelKeyframes() {
  try {
    if (document.getElementById("sm-panel-fade-style")) return;
    const style = document.createElement("style");
    style.id = "sm-panel-fade-style";
    style.textContent = "@keyframes sm-panel-fade { from { opacity: 0 } to { opacity: 1 } }";
    (document.head || document.documentElement).appendChild(style);
  } catch { /* noop */ }
})();

export default function register(ctx) {
  const { h, useState, useEffect, useRef, t, apiUrl } = ctx;

  const store = {
    sessions: [],
    running: new Set(),
    tagData: null, // { version, favoriteIds, tags, sessionTags }
    version: 0,
    listeners: new Set(),
  };

  function emit() { store.version++; for (const l of store.listeners) l(); }
  function subscribe(l) { store.listeners.add(l); return () => store.listeners.delete(l); }

  function useStore() {
    const [, force] = useState(0);
    useEffect(() => subscribe(() => force((v) => v + 1)), []);
    return store;
  }

  /* Shared tag filter across the panel + topbar chips (§4.2/§3.4). */
  const sharedFilter = { tagIds: [], listeners: new Set() };
  function notifyFilter() { for (const l of sharedFilter.listeners) l(); }
  function toggleSharedFilter(tagId) {
    const has = sharedFilter.tagIds.includes(tagId);
    sharedFilter.tagIds = has ? sharedFilter.tagIds.filter((x) => x !== tagId) : [...sharedFilter.tagIds, tagId];
    notifyFilter();
  }
  function useSharedFilter() {
    const [, force] = useState(0);
    useEffect(() => {
      const l = () => force((v) => v + 1);
      sharedFilter.listeners.add(l);
      return () => sharedFilter.listeners.delete(l);
    }, []);
    return sharedFilter.tagIds;
  }

  let sessionsEtag = "";
  async function refreshSessions() {
    try {
      // Merged live + archived list (extension endpoint); running from core.
      const [res, runRes] = await Promise.all([
        fetch(apiUrl("/api/extensions/session-manager/sessions"), {
          headers: sessionsEtag ? { "if-none-match": sessionsEtag } : undefined,
        }),
        fetch(apiUrl("/api/agent/running"), { cache: "no-store" }),
      ]);
      // 304：列表未变，沿用旧数据（跳过解析/emit/重渲染 491 行）
      if (res.status === 304) {
        sessionsEtag = res.headers.get("etag") ?? sessionsEtag;
        if (runRes.ok) {
          const r = await runRes.json();
          store.running = new Set(r.runningSessionIds ?? []);
          emit();
        }
        return;
      }
      if (!res.ok) return;
      sessionsEtag = res.headers.get("etag") ?? "";
      const d = await res.json();
      store.sessions = d.sessions ?? [];
      if (runRes.ok) {
        const r = await runRes.json();
        store.running = new Set(r.runningSessionIds ?? []);
      }
      emit();
    } catch { /* keep last */ }
  }

  // 轻量运行计数刷新：只拉 agent/running（~10ms、零字节级），不拉 sessions 全量。
  // 供侧边栏/工具栏运行徽标用——它们只需要 running 集合，拉 348KB 列表是浪费。
  async function refreshRunning() {
    try {
      const res = await fetch(apiUrl("/api/agent/running"), { cache: "no-store" });
      if (!res.ok) return;
      const r = await res.json();
      store.running = new Set(r.runningSessionIds ?? []);
      emit();
    } catch { /* keep last */ }
  }

  async function refreshTags() {
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/session-tags"));
      if (!res.ok) return;
      store.tagData = await res.json();
      emit();
    } catch { /* keep last */ }
  }

  /**
   * Notify pi-web's sidebar that the on-disk session list changed out from
   * under it (archive / archive-delete). SessionSidebar listens for this event
   * and refetches with ?refresh=1 (bypassing the 5s TTL list cache).
   */
  function notifySessionsChanged() {
    try { window.dispatchEvent(new Event("sm:sessions-changed")); } catch { /* non-DOM */ }
  }

  /** Archive one session now (explicit id — bypasses age/size heuristics). Server refuses running ids. */
  async function archiveSession(id) {
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/archive/run"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      void refreshSessions();
      notifySessionsChanged();
      return res.ok;
    } catch { return false; }
  }

  /** Put an archived session back to its original live path (恢复). */
  async function restoreSession(id) {
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/archive/restore"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      void refreshSessions();
      notifySessionsChanged();
      return res.ok;
    } catch { return false; }
  }

  /** Permanently delete an archived session (archive records only — 先归档才能删除). */
  async function deleteArchivedSession(id) {
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/archive/delete"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      void refreshSessions();
      notifySessionsChanged();
      return res.ok;
    } catch { return false; }
  }

  /** POST an action; handles the optimistic-lock 409 by re-fetching + retrying once. */
  async function act(name, payload) {
    // Retry a few times: concurrent tabs all race on the same optimistic version
    // — only the first wins, the rest get 409 and re-fetch + retry.
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = store.tagData ?? { version: 0 };
      try {
        const res = await fetch(apiUrl(`/api/extensions/session-manager/${name}`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: t0.version, ...payload }),
        });
        if (res.status === 409) { await refreshTags(); continue; }
        if (res.ok) {
          const d = await res.json();
          store.tagData = d.data;
          emit();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    await refreshTags();
    return false;
  }

  /** Whole-file PUT (used by the picker's create-new flow). */
  async function actPut(next) {
    const res = await fetch(apiUrl("/api/extensions/session-manager/session-tags"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    if (res.ok) { const d = await res.json(); store.tagData = d.data; emit(); return true; }
    await refreshTags();
    return false;
  }

  /* ═══════════ helpers ═══════════ */

  /** Client-side copy of the tag lib's defaultColorFor (display-only reset). */
  function defaultColorForClient(name) {
    const map = { todo: "var(--warn, #f59e0b)", bugfix: "var(--danger, #ef4444)", bug: "var(--danger, #ef4444)", urgent: "var(--danger, #ef4444)", feature: "var(--ok, #22c55e)", review: "#8b5cf6", docs: "#3b82f6", test: "#06b6d4", refactor: "#64748b", chore: "#64748b" };
    const hit = map[name.trim().toLowerCase()];
    if (hit) return hit;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const palette = ["var(--danger, #ef4444)", "#f97316", "var(--warn, #f59e0b)", "var(--ok, #22c55e)", "var(--ok, #10b981)", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b"];
    return palette[h % palette.length];
  }

  function fmtRelative(iso) {
    const t0 = Date.parse(iso);
    if (Number.isNaN(t0)) return "";
    const diff = Date.now() - t0;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    if (hr < 24) return `${hr}h`;
    const d = Math.floor(hr / 24);
    if (d < 7) return `${d}d`;
    return new Date(iso).toLocaleDateString();
  }

  function byIdMap(data) {
    return new Map((data?.tags ?? []).map((t) => [t.id, t]));
  }

  /** node → "a/b/c" path (display form). */
  function tagPath(nodeId, data) {
    const byId = byIdMap(data);
    const segs = [];
    let cur = byId.get(nodeId);
    while (cur) {
      segs.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return segs.join("/");
  }

  /** leaf name for chips. */
  function tagLeafName(nodeId, data) {
    return byIdMap(data).get(nodeId)?.name ?? nodeId;
  }

  function sessionTagIds(sessionId, data) {
    return data?.sessionTags?.[sessionId] ?? [];
  }

  /** session tag ids → matching when the tag or an ancestor is selected. */
  function matchesTags(sessionId, data, selectedIds) {
    if (!selectedIds.length) return true;
    const byId = byIdMap(data);
    const selected = new Set(selectedIds);
    for (const sid of sessionTagIds(sessionId, data)) {
      let cur = byId.get(sid);
      while (cur) {
        if (selected.has(cur.id)) return true;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    return false;
  }

  function sessionTitle(s) {
    return s.name || s.firstMessage || s.id.slice(0, 12);
  }

  /* home dir for ~ display — fetched once from core /api/home (not hardcoded). */
  let homeDir = null;
  function getHomeDir() { return homeDir; }
  {
    fetch(apiUrl("/api/home")).then((r) => r.json()).then((d) => { if (d.home) homeDir = d.home; }).catch(() => {});
  }

  function displayCwd(cwd) {
    if (homeDir && cwd.startsWith(homeDir)) return "~" + cwd.slice(homeDir.length);
    return cwd;
  }

  /* §14.2.6 search hit highlighting — escape, then wrap query terms in <mark>. */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
  }
  function highlight(text, q) {
    const safe = escapeHtml(text);
    const term = escapeHtml(q.trim());
    if (!term) return safe;
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return safe.replace(re, "<mark style='background:color-mix(in srgb, var(--warn, #f59e0b) 35%, transparent);color:inherit;border-radius:2px;padding:0 1px'>$1</mark>");
  }

  /* §14.2.2 date presets (filter by session.modified). */
  const DATE_PRESETS = [
    { key: "", label: () => t("sm.allTags") },
    { key: "today", label: () => t("sm.today") },
    { key: "24h", label: () => t("sm.last24h") },
    { key: "2d", label: () => t("sm.last2d") },
    { key: "7d", label: () => t("sm.last7d") },
    { key: "30d", label: () => t("sm.last30d") },
  ];
  function dateFilterMatches(iso, preset) {
    if (!preset) return true;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return preset.startsWith("day:") ? false : true;
    if (preset === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return t >= d.getTime(); }
    if (preset === "24h") return t >= Date.now() - 86400000;
    if (preset === "2d") return t >= Date.now() - 2 * 86400000;
    if (preset === "7d") return t >= Date.now() - 7 * 86400000;
    if (preset === "30d") return t >= Date.now() - 30 * 86400000;
    if (preset.startsWith("day:")) {
      const day = preset.slice(4);
      const d = new Date(t);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return key === day;
    }
    return true;
  }

  /* §14.4.1 last-role badge + summary line. */
  function roleBadge(role) {
    if (role === "user") return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [h("path", { key: "p1", d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" })]);
    if (role === "toolResult") return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [h("path", { key: "p1", d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" })]);
    return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [h("path", { key: "p1", d: "M12 8V4H8" }), h("path", { key: "p2", d: "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" }), h("path", { key: "p3", d: "M2 14h2" }), h("path", { key: "p4", d: "M20 14h2" }), h("path", { key: "p5", d: "M15 13v2" }), h("path", { key: "p6", d: "M9 13v2" })]);
  }

  /* ═══════════ shared UI bits ═══════════ */

  function makeFlag() {
    return {
      value: false,
      subs: new Set(),
      onOpen() { this.value = true; for (const l of this.subs) l(); },
      onClose() { this.value = false; for (const l of this.subs) l(); },
    };
  }

  const panelOpen = makeFlag();
  const managerOpen = makeFlag();
  const kanbanOpen = makeFlag();
  // 顶栏搜索框 → 全部会话面板的待消费查询词（提交时设置，面板打开时注入）
  let pendingSearch = "";

  function StarButton({ sessionId, onToggle }) {
    const s = useStore();
    const fav = !!s.tagData && s.tagData.favoriteIds.includes(sessionId);
    return h("button", {
      title: fav ? t("sm.unfavorite") : t("sm.favorite"),
      onClick: (e) => { e.stopPropagation(); onToggle(!fav); },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0,
        background: "none", border: "none", cursor: "pointer",
        color: fav ? "var(--warn, #f59e0b)" : "var(--text-dim)",
      },
    }, fav ? "★" : "☆");
  }

  /** Fixed-position tag editor popover — escapes overflow:hidden row clipping. */
  function TagEditPopover({ sessionId }) {
    const s = useStore();
    const [popover, setPopover] = useState(null);
    const data = s.tagData ?? EMPTY_TAGS;
    const tagIds = sessionTagIds(sessionId, data);
    return h("span", { style: { display: "inline-flex" } },
      h("button", {
        title: t("sm.addTag"),
        onClick: (e) => {
          e.stopPropagation();
          if (popover) { setPopover(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          setPopover({ top: r.bottom + 4, left: Math.max(8, r.right - 260) });
        },
        style: {
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, padding: 0, flexShrink: 0,
          background: "none", border: "none", cursor: "pointer",
          color: tagIds.length ? "var(--accent)" : "var(--text-dim)", fontSize: 13,
        },
      }, "#"),
      popover && h("div", {
        style: {
          position: "fixed", top: popover.top, left: popover.left, zIndex: 400,
          display: "flex", flexDirection: "column", gap: 4, padding: 6,
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 6px 18px rgba(0,0,0,0.25)", width: 260,
        },
        onClick: (e) => e.stopPropagation(),
      },
        /* current tags on this session (removable) */
        tagIds.map((tid) => h(TagChip, {
          key: tid, tagId: tid, data,
          onRemove: () => void act("unassign", { sessionId, tagId: tid }),
        })),
        /* §4.1 (user req): the picker opens automatically — pick an existing
           tag from the tree, or type a new path below. */
        h(TagPicker, {
          onPick: (tagId) => { void act("assignTag", { sessionId, tagId }); setPopover(null); },
        }),
      ),
    );
  }

  /** "选择或输入" picker: browsable tag tree + search + new-path input (§3.4). */
  function TagPicker({ onPick, onClose, position }) {
    const s = useStore();
    const [q, setQ] = useState("");
    const [collapsed, setCollapsed] = useState(new Set());
    const [newPath, setNewPath] = useState("");
    const data = s.tagData ?? EMPTY_TAGS;
    const byId = byIdMap(data);
    const roots = data.tags.filter((t) => !t.parentId || !byId.has(t.parentId))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const usage = (nodeId) => {
      const set = new Set(descendantsLocal(nodeId, byId));
      return Object.values(data.sessionTags).filter((ids) => ids.some((x) => set.has(x))).length;
    };
    const visible = (node, depth) => {
      const path = tagPath(node.id, data);
      if (q && !path.toLowerCase().includes(q.toLowerCase())) return null;
      const children = data.tags.filter((t) => t.parentId === node.id)
        .sort((a, b) => a.name.localeCompare(b.name));
      const isCollapsed = collapsed.has(node.id);
      return [
        h("div", {
          key: node.id,
          style: { display: "flex", alignItems: "center", gap: 5, padding: "3px 4px 3px " + (4 + depth * 14) + "px", fontSize: 11, borderRadius: 5 },
          onMouseEnter: (e) => { e.currentTarget.style.background = "var(--bg-hover)"; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "none"; },
        },
          children.length > 0 && h("span", {
            onClick: (e) => { e.stopPropagation(); setCollapsed((prev) => { const n = new Set(prev); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); },
            style: { cursor: "pointer", width: 12, textAlign: "center", color: "var(--text-dim)", flexShrink: 0 },
          }, isCollapsed ? "▸" : "▾"),
          children.length === 0 && h("span", { style: { width: 12, flexShrink: 0 } }),
          h("span", { style: { width: 9, height: 9, borderRadius: 3, background: node.color, flexShrink: 0 } }),
          h("span", {
            onClick: () => onPick(node.id),
            style: { cursor: "pointer", color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
            title: path,
          }, path),
          h("span", { style: { color: "var(--text-dim)", fontSize: 10, flexShrink: 0 } }, usage(node.id)),
        ),
        !isCollapsed && children.map((c) => visible(c, depth + 1)),
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
    const box = position
      ? { position: "fixed", top: position.top, left: position.left, zIndex: 410, width: 240, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 18px rgba(0,0,0,0.25)" }
      : { display: "flex", flexDirection: "column", gap: 4, marginTop: 4, borderTop: "1px solid var(--border)", paddingTop: 4 };
    return h("div", {
      style: box,
      onClick: (e) => e.stopPropagation(),
    },
      h("input", {
        value: q,
        placeholder: t("sm.searchPlaceholder"),
        onChange: (e) => setQ(e.target.value),
        style: inputStyle,
      }),
      h("div", { style: { maxHeight: 200, overflowY: "auto" } },
        roots.map((r) => visible(r, 0)),
        data.tags.length === 0 && h("div", { style: { padding: 8, color: "var(--text-dim)", fontSize: 11 } }, t("sm.noSessions")),
      ),
      h("div", { style: { display: "flex", gap: 4 } },
        h("input", {
          value: newPath,
          placeholder: t("sm.tagPlaceholder"),
          onChange: (e) => setNewPath(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") void createNew(); },
          style: { ...inputStyle, flex: 1 },
        }),
        h("button", { onClick: () => void createNew(), style: { ...ghostBtn, background: "var(--accent)", color: "#fff", borderStyle: "none" } }, t("sm.newTag")),
      ),
    );
  }

  function TagChip({ tagId, data, onClick, onRemove }) {
    const node = byIdMap(data).get(tagId);
    if (!node) return null;
    return h("span", {
      title: tagPath(tagId, data),
      onClick,
      style: {
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "1px 7px", borderRadius: 9, fontSize: 10, lineHeight: "15px",
        background: node.color + "26", color: node.color,
        border: `1px solid ${node.color}55`, cursor: onClick ? "pointer" : "default",
        whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
      },
    },
      node.name,
      onRemove && h("span", {
        onClick: (e) => { e.stopPropagation(); onRemove(); },
        style: { cursor: "pointer", opacity: 0.8, marginLeft: 2 },
      }, "×"),
    );
  }

  /* ═══════════ SessionsPanel (dialogs slot) ═══════════ */

  const PAGE_SIZE = 20;

  /* ── archived session viewer (read-only) ── */
  const viewerState = { sessionId: null, subs: new Set() };
  function openViewer(id) { viewerState.sessionId = id; for (const l of viewerState.subs) l(); }
  function closeViewer() { viewerState.sessionId = null; for (const l of viewerState.subs) l(); }

  function ArchivedViewer() {
    const [sessionId, setSessionId] = useState(viewerState.sessionId);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
      const l = () => setSessionId(viewerState.sessionId);
      viewerState.subs.add(l);
      return () => viewerState.subs.delete(l);
    }, []);
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
    const close = () => closeViewer();
    const msgBlock = (m) => h("div", {
      key: m.entryId, style: { marginBottom: 8, padding: "6px 10px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" },
    },
      h("div", { style: { fontSize: 10, color: "var(--text-dim)", marginBottom: 3 } },
        `${m.role === "user" ? "🧑" : m.role === "toolResult" ? "🛠" : "🤖"} ${m.role}${m.model ? " · " + m.model : ""}`),
      h("div", { style: { fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, m.text),
    );

    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      onClick: close,
    },
      h("div", {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: "min(720px, 94vw)", height: "min(80vh, 720px)", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        },
      },
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" } },
          h("strong", { style: { fontSize: 13 } }, `${sessionId.slice(0, 8)}`),
          h("span", { style: { fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, data?.meta?.cwd ?? ""),
          h("span", { style: { marginLeft: "auto", display: "flex", gap: 6 } },
            h("a", {
              href: apiUrl(`/api/extensions/session-manager/archive/export/${sessionId}?format=jsonl`),
              style: { ...ghostBtn, textDecoration: "none", display: "inline-block" },
            }, "jsonl"),
            h("a", {
              href: apiUrl(`/api/extensions/session-manager/archive/export/${sessionId}?format=md`),
              style: { ...ghostBtn, textDecoration: "none", display: "inline-block" },
            }, "md"),
            h("button", { onClick: close, style: ghostBtn }, t("sm.close")),
          ),
        ),
        err ? h("div", { style: { padding: 20, color: "var(--danger, #f87171)", fontSize: 12 } }, err)
          : !data ? h("div", { style: { padding: 20, color: "var(--text-dim)", fontSize: 12 } }, t("sm.empty"))
          : h("div", { style: { flex: 1, overflowY: "auto", padding: "10px 12px" } }, data.messages.map(msgBlock)),
      ),
    );
  }

  function SessionsPanel(props) {
    const s = useStore();
    const [open, setOpen] = useState(panelOpen.value);
    useEffect(() => {
      const l = () => setOpen(panelOpen.value);
      panelOpen.subs.add(l);
      return () => panelOpen.subs.delete(l);
    }, []);

    // T-1: defer the list content to the frame AFTER the overlay/frame appears.
    // Opening mounts a full section tree (favorites + running + a page of rows)
    // in one shot, which forces one big layout (~675 nodes / 46ms from trace).
    // Splitting it into two frames — overlay+header first, rows one frame later —
    // keeps the open interaction responsive and halves the per-frame layout work.
    // A CSS opacity transition on the frame (transform/opacity only, no layout)
    // runs in the meantime, so the deferred rows are invisible while they mount.
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
    const [searchHits, setSearchHits] = useState(null); // null = not searching
    const [rowBusy, setRowBusy] = useState(new Set());
    const [archStatus, setArchStatus] = useState(null);
    const [archBusy, setArchBusy] = useState(false);
    const markBusy = (id) => setRowBusy((prev) => new Set(prev).add(id));
    const markDone = (id) => setRowBusy((prev) => { const n = new Set(prev); n.delete(id); return n; });
    const isBusy = (id) => rowBusy.has(id);
    const [archivedOnly, setArchivedOnly] = useState(false);
    const [favOnly, setFavOnly] = useState(false);
    // §14.2 filter menu + §14.3 stats drawer + §14.4 batch/rename
    const [filterOpen, setFilterOpen] = useState(false);
    const [modelFilter, setModelFilter] = useState("");
    const [roleFilter, setRoleFilter] = useState("");
    const [datePreset, setDatePreset] = useState("");
    const [sortBy, setSortBy] = useState("modified");
    const [sortAsc, setSortAsc] = useState(false);
    const [stats, setStats] = useState(null);
    const [statsOpen, setStatsOpen] = useState(false);
    const [selection, setSelection] = useState(new Set());
    const [batchBusy, setBatchBusy] = useState(false);
    const [renamingId, setRenamingId] = useState(null);
    const [renameVal, setRenameVal] = useState("");
    const [expandedTags, setExpandedTags] = useState(new Set());
    /* §4 section collapse — persisted so a long favorites list stays folded across reopens/reloads */
    const [collapsedSections, setCollapsedSections] = useState(() => {
      try { return new Set(JSON.parse(localStorage.getItem("sm.collapsedSections") ?? "[]")); }
      catch { return new Set(); }
    });
    const toggleSection = (key) => setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("sm.collapsedSections", JSON.stringify([...next])); } catch {}
      return next;
    });
    const selectedTags = useSharedFilter(); // shared with topbar chips (§3.4)
    const searchRef = useRef(null);
    // 顶栏搜索框：每次提交（含面板已打开状态）把查询词注入面板 + 聚焦搜索框；
    // 面板关闭时也注册（返回 null 的组件 hooks 仍生效），打开后查询词即生效。
    useEffect(() => {
      const l = () => {
        if (pendingSearch) {
          const q = pendingSearch;
          pendingSearch = "";
          setQuery(q);
          setPage(0);
          requestAnimationFrame(() => searchRef.current?.focus());
        }
      };
      panelOpen.subs.add(l);
      return () => panelOpen.subs.delete(l);
    }, []);
    useEffect(() => {
      const id = setTimeout(() => { setDebounced(query); setPage(0); }, 150);
      return () => clearTimeout(id);
    }, [query]);

    // §12.1 shortcuts: Cmd/Ctrl+F focuses the search box, Esc closes the panel.
    useEffect(() => {
      if (!open) return;
      const onKey = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        } else if (e.key === "Escape") {
          // While typing (rename input / tag editor) the input handles Esc itself
          // (capture-phase panel handler must not steal it).
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
          panelOpen.onClose();
        }
      };
      document.addEventListener("keydown", onKey, true);
      return () => document.removeEventListener("keydown", onKey, true);
    }, [open]);

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
          void refreshSessions();
        }
      } finally {
        setArchBusy(false);
      }
    };

    useEffect(() => {
      if (!open) return;
      void refreshSessions();
      void refreshTags();
      refreshArchStatus();
      const iv = setInterval(() => void refreshSessions(), 5000);
      return () => clearInterval(iv);
    }, [open]);

    // T-1b+ : incremental "load more" for the big fav/running sections — they
    // render SECTION_PAGE_SIZE rows first, then grow per button click (completed
    // already paginates via PAGE_SIZE). State lives with the other hooks (must be
    // declared before the early return below — React Rules of Hooks).
    const SECTION_PAGE_SIZE = 20;
    const [favLoaded, setFavLoaded] = useState(SECTION_PAGE_SIZE);
    const [runningLoaded, setRunningLoaded] = useState(SECTION_PAGE_SIZE);
    // Reset the incremental states whenever the underlying list identity changes
    // (filter/search) so pagination always starts from the first page.
    useEffect(() => { setFavLoaded(SECTION_PAGE_SIZE); setRunningLoaded(SECTION_PAGE_SIZE); }, [debounced, modelFilter, roleFilter, datePreset, archivedOnly, favOnly, selectedTags.join("\u0000")]);

    if (!open) return null;

    const data = s.tagData ?? EMPTY_TAGS;
    const byId = byIdMap(data);
    const q = debounced.trim();
    const activeFilterCount =
      (archivedOnly ? 1 : 0) + (favOnly ? 1 : 0) + selectedTags.length +
      (modelFilter ? 1 : 0) + (roleFilter ? 1 : 0) + (datePreset ? 1 : 0);

    // When searching, the index is the source (live + archived unified).
    const base = searchHits
      ? searchHits.map((h) => ({
          id: h.sessionId, name: h.title, cwd: h.cwd, modified: h.modified,
          firstMessage: h.text, lastMessage: h.text, lastRole: h.role, archived: h.archived, messageCount: 0,
        }))
      : s.sessions;
    const byIdL = new Map(base.map((x) => [x.id, x]));

    // §14.2.2/14.2.3: local filters (list mode) + sort.
    // Archived sessions are HIDDEN by default — the 📦 已归档 chip opts in
    // (and then shows archived only). Keeps the list clean as auto-archive
    // accumulates; search hits follow the same rule for consistency.
    // Exception: FAVOURITED sessions keep appearing in the default favourites
    // section even after archiving — a star is an explicit user bookmark, and
    // archiving must not make it vanish (the archived row shows 📦 so it stays
    // distinguishable). Tags/star on an archived row are stored in the tags
    // data (survives archive) and render normally in the 📦 view; the default
    // view just surfaces starred-archived rows back in Favourites.
    const favIds = new Set(data.favoriteIds);
    const archivedCount = base.reduce((n, x) => n + (x.archived ? 1 : 0), 0);
    const filtered = base.filter((sess) =>
      (archivedOnly ? sess.archived : !sess.archived || favIds.has(sess.id))
      && (!favOnly || favIds.has(sess.id))
      && matchesTags(sess.id, data, selectedTags)
      && (!modelFilter || sess.model === modelFilter)
      && dateFilterMatches(sess.modified, datePreset));
    const favorites = filtered.filter((x) => favIds.has(x.id));
    const runningList = filtered.filter((x) => s.running.has(x.id) && !favIds.has(x.id));
    const sortVal = (x) => {
      if (sortBy === "created") return x.created ?? "";
      if (sortBy === "name") return (x.name ?? x.firstMessage ?? "").toLowerCase();
      if (sortBy === "messageCount") return x.messageCount ?? 0;
      return x.modified ?? "";
    };
    const cmp = (a, b) => {
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
    const usageCount = (nodeId) => {
      const set = new Set(descendantsLocal(nodeId, byId));
      return base.filter((x) => sessionTagIds(x.id, data).some((tid) => set.has(tid))).length;
    };
    const chipRow = (node, depth) => {
      const children = data.tags.filter((t) => t.parentId === node.id)
        .sort((a, b) => a.name.localeCompare(b.name));
      const count = usageCount(node.id);
      const isParent = children.length > 0;
      const expanded = expandedTags.has(node.id);
      return [
        h("span", {
          key: node.id,
          onClick: () => toggleSharedFilter(node.id),
          title: tagPath(node.id, data),
          style: {
            display: "inline-flex", alignItems: "center", gap: 3,
            marginLeft: depth * 14,
            padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
            background: selectedTags.includes(node.id) ? node.color + "33" : node.color + "1a",
            color: node.color,
            border: `1px solid ${selectedTags.includes(node.id) ? node.color : node.color + "33"}`,
          },
        },
          isParent && h("span", {
            onClick: (e) => { e.stopPropagation(); setExpandedTags((prev) => { const n = new Set(prev); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); },
            style: { cursor: "pointer", fontSize: 9, color: "inherit", opacity: 0.8 },
          }, expanded ? "▾" : "▸"),
          node.name,
          h("span", { style: { opacity: 0.75, fontSize: 9 } }, count),
        ),
        expanded && children.map((c) => chipRow(c, depth + 1)),
      ];
    };

    /* §14.3 stat card + §14.3 heatmap grid + §14.4 batch ops */
    const statCard = (icon, value, label) => h("div", {
      style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 9, background: "var(--bg-hover)", border: "1px solid var(--border)" },
    },
      h("span", { style: { fontSize: 14 } }, icon),
      h("div", null,
        h("div", { style: { fontSize: 15, fontWeight: 700, color: "var(--text)", lineHeight: 1.1 } }, value),
        h("div", { style: { fontSize: 10, color: "var(--text-dim)" } }, label),
      ),
    );
    const HEAT_COLORS = ["var(--bg-hover)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 25%, transparent)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 45%, transparent)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 70%, transparent)", "var(--ok, #10b981)"];
    const heatmapGrid = (points, onPick) => h("div", { style: { display: "grid", gridTemplateColumns: "repeat(26, 1fr)", gap: 2, maxHeight: 120, overflowY: "auto" } },
      points.map((p) => h("div", {
        key: p.date,
        title: `${p.date} · ${p.messages} 条 · ${p.sessions} 会话`,
        onClick: () => p.messages > 0 && onPick(p.date),
        style: {
          aspectRatio: "1", borderRadius: 2, cursor: p.messages > 0 ? "pointer" : "default",
          background: HEAT_COLORS[p.level],
          border: p.messages > 0 && p.level === 0 ? "1px solid color-mix(in srgb, var(--ok, var(--ok, #10b981)) 30%, transparent)" : "none",
        },
      })),
    );
    const batchArchive = async () => {
      if (batchBusy) return;
      setBatchBusy(true);
      try {
        // running sessions are never archived (server also enforces this)
        const ids = [...selection].filter((id) => !s.running.has(id) && !(byIdL.get(id)?.archived));
        const skipped = selection.size - ids.length;
        const res = await fetch(apiUrl("/api/extensions/session-manager/archive/run"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        if (res.ok) { setSelection(new Set()); refreshArchStatus(); void refreshSessions(); notifySessionsChanged(); }
        if (skipped > 0 && res.ok) window.alert?.(`跳过 ${skipped} 个（运行中/已归档）`);
      } finally { setBatchBusy(false); }
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
      setBatchBusy(true);
      try {
        // permanent delete — ARCHIVE RECORDS ONLY (先归档才能删除): live files must be archived first
        const ids = [...selection].filter((id) => byIdL.get(id)?.archived);
        const skipped = selection.size - ids.length;
        if (ids.length && !window.confirm?.(t("sm.confirmDeleteArchiveN", { count: ids.length }))) {
          setBatchBusy(false);
          return;
        }
        let failed = 0;
        for (const id of ids) {
          const ok = await deleteArchivedSession(id);
          if (!ok) failed++;
        }
        setSelection(new Set());
        void refreshSessions();
        notifySessionsChanged();
        if (failed > 0) window.alert?.(`${failed} 个删除失败`);
        else if (skipped > 0) window.alert?.(`跳过 ${skipped} 个未归档会话（先归档才能删除）`);
      } finally { setBatchBusy(false); }
    };
    const startRename = (sess) => { setRenamingId(sess.id); setRenameVal(sess.name ?? ""); };
    const submitRename = async () => {
      const id = renamingId;
      const name = renameVal.trim();
      setRenamingId(null);
      if (!id || !name) return;
      await fetch(apiUrl(`/api/sessions/${id}`), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      void refreshSessions();
    };

    const row = (sess) => h("div", {
      key: sess.id,
      onClick: () => {
        if (sess.archived) openViewer(sess.id);
        else {
          // §4.1: selecting a session closes the panel
          props.onSelectSession?.(sess);
          panelOpen.onClose();
        }
      },
      style: {
        display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
        cursor: "pointer", borderRadius: 7,
      },
      onMouseEnter: (e) => { e.currentTarget.style.background = "var(--bg-hover)"; },
      onMouseLeave: (e) => { e.currentTarget.style.background = "none"; },
    },
      /* §14.4 batch checkbox (hover-visible) */
      h("span", {
        onClick: (e) => {
          e.stopPropagation();
          setSelection((prev) => { const n = new Set(prev); if (n.has(sess.id)) n.delete(sess.id); else n.add(sess.id); return n; });
        },
        style: {
          flexShrink: 0, cursor: "pointer", userSelect: "none", width: 16, textAlign: "center",
          fontSize: 13, opacity: selection.has(sess.id) ? 1 : 0.25,
        },
        onMouseEnter: (e) => { e.currentTarget.style.opacity = 1; },
        onMouseLeave: (e) => { if (!selection.has(sess.id)) e.currentTarget.style.opacity = 0.25; },
      }, selection.has(sess.id) ? "☑" : "☐"),
      h("div", { style: { width: 14, flexShrink: 0, color: "var(--accent)", fontSize: 11, textAlign: "center" } },
        s.running.has(sess.id) ? "⟳" : sess.archived ? "📦" : ""),
      h("div", { style: { flex: 1, minWidth: 0 } },
        renamingId === sess.id
          ? h("input", {
              value: renameVal,
              onChange: (e) => setRenameVal(e.target.value),
              onBlur: () => void submitRename(),
              onKeyDown: (e) => {
                if (e.key === "Enter") { e.preventDefault(); void submitRename(); }
                if (e.key === "Escape") { setRenameVal(""); setRenamingId(null); }
              },
              style: { ...inputStyle, padding: "2px 6px", fontSize: 12, marginBottom: 2 },
              autoFocus: true,
            })
          : h("div", { style: { display: "flex", alignItems: "center", gap: 5, minWidth: 0 } },
              /* §14.2.6: search hits render the snippet with <mark> highlights */
              searchHits
                ? h("span", { style: { fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, dangerouslySetInnerHTML: { __html: highlight(sess.firstMessage, q) } })
                : h("span", { style: { fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sessionTitle(sess)),
              /* §14.4.4 inline rename (archived sessions cannot be renamed — core PATCH resolves live files only) */
              !sess.archived && h("button", {
                title: t("sm.rename"),
                onClick: (e) => { e.stopPropagation(); startRename(sess); },
                style: { ...miniBtn, opacity: 0.45, fontSize: 10 },
              }, "✏"),
            ),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 1, fontSize: 10, color: "var(--text-dim)" } },
          h("span", { style: { fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 } }, displayCwd(sess.cwd)),
          h("span", null, fmtRelative(sess.modified)),
          h("span", null, t("sm.msgCount", { count: sess.messageCount })),
          /* §14.4.1 last-role badge + summary */
          sess.lastRole && h("span", { title: `最后角色: ${sess.lastRole}` }, roleBadge(sess.lastRole)),
        ),
        /* §14.4.1 last message summary line */
        sess.lastMessage && h("div", {
          style: { marginTop: 2, fontSize: 10, color: "var(--text-dim)", opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        }, sess.lastMessage.length > 60 ? sess.lastMessage.slice(0, 60) + "…" : sess.lastMessage),
        sessionTagIds(sess.id, data).length > 0 && h("div", { style: { display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" } },
          sessionTagIds(sess.id, data).map((tid) => h(TagChip, {
            key: tid, tagId: tid, data,
            onClick: () => toggleSharedFilter(tid),
          })),
        ),
      ),
      h(StarButton, {
        sessionId: sess.id,
        onToggle: (on) => void act(on ? "favorite" : "unfavorite", { sessionId: sess.id }),
      }),
      h(TagEditPopover, { sessionId: sess.id }),
      /* per-row archive (live rows, not running) — replaces direct delete: archive first, then delete */
      !sess.archived && !s.running.has(sess.id) && h("button", {
        title: isBusy(sess.id) ? t("sm.archiving") ?? "归档中…" : t("sm.archive"),
        disabled: isBusy(sess.id),
        onClick: (e) => {
          e.stopPropagation();
          if (isBusy(sess.id)) return;
          markBusy(sess.id);
          void archiveSession(sess.id).finally(() => markDone(sess.id));
        },
        style: { ...miniBtn, opacity: isBusy(sess.id) ? 0.8 : 0.45, fontSize: 10, flexShrink: 0 },
      }, isBusy(sess.id) ? "⟳" : "📦"),
      /* archived rows: ↩ restore + 🗑 permanent delete */
      sess.archived && h("button", {
        title: isBusy(sess.id) ? t("sm.restoring") ?? "恢复中…" : t("sm.restore"),
        disabled: isBusy(sess.id),
        onClick: (e) => {
          e.stopPropagation();
          if (isBusy(sess.id)) return;
          markBusy(sess.id);
          void restoreSession(sess.id).finally(() => markDone(sess.id));
        },
        style: { ...miniBtn, opacity: isBusy(sess.id) ? 0.8 : 0.45, fontSize: 10, flexShrink: 0 },
      }, isBusy(sess.id) ? "⟳" : "↩"),
      /* permanent delete — archive records only */
      sess.archived && h("button", {
        title: isBusy(sess.id) ? t("sm.deleting") ?? "删除中…" : t("sm.deleteArchive"),
        disabled: isBusy(sess.id),
        onClick: (e) => {
          e.stopPropagation();
          if (isBusy(sess.id)) return;
          if (window.confirm?.(t("sm.confirmDeleteArchive"))) {
            markBusy(sess.id);
            void deleteArchivedSession(sess.id).finally(() => markDone(sess.id));
          }
        },
        style: { ...miniBtn, opacity: isBusy(sess.id) ? 0.8 : 0.45, fontSize: 10, flexShrink: 0, color: "var(--danger, #f87171)" },
      }, isBusy(sess.id) ? "⟳" : "🗑"),
    );

    // section renders `items` (already sliced to the loaded page). If the
    // underlying list has more rows than the page, a "load more" button grows
    // the page by onMore() (incremental loading — see SECTION_PAGE_SIZE above).
    const section = (key, title, items, total, onMore) => items.length === 0 ? null : h("div", { style: { marginBottom: 8, contain: "layout style" } },
      h("div", {
        onClick: () => toggleSection(key),
        style: {
          fontSize: 11, fontWeight: 600, color: "var(--text-muted)", padding: "4px 10px",
          letterSpacing: "0.04em", textTransform: "uppercase",
          cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4,
        },
      },
        h("span", {
          style: {
            fontSize: 9, display: "inline-block", transition: "transform 0.15s",
            transform: collapsedSections.has(key) ? "rotate(-90deg)" : "none",
          },
        }, "▾"),
        `${title} (${total})`),
      !collapsedSections.has(key) && h("div", { style: { contain: "layout style", contentVisibility: "auto" } },
        items.map(row),
        onMore && total > items.length && h("div", { style: { padding: "4px 10px" } },
          h("button", { onClick: onMore, style: ghostBtn }, t("sm.loadMore", { n: Math.min(SECTION_PAGE_SIZE, total - items.length) })),
        ),
      ),
    );

    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 290,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center",
        // T-2: fade the frame in with opacity — a compositor-only animation,
        // so opening never forces a synchronous layout of the dialog tree.
        animation: "sm-panel-fade 0.12s ease-out",
      },
      onClick: () => panelOpen.onClose(),
    },
      h("div", {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: "min(680px, 94vw)", height: "min(78vh, 700px)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 14, overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        },
      },
        /* header: title + search + filters/stats + archive strip */
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" } },
          h("strong", { style: { fontSize: 13, color: "var(--text)", whiteSpace: "nowrap" } }, t("sm.allSessions")),
          h("input", {
            ref: searchRef,
            value: query,
            placeholder: t("sm.searchPlaceholder"),
            onChange: (e) => setQuery(e.target.value),
            style: inputStyle,
          }),
          /* §14.2 filter menu trigger (active-count badge) */
          h("button", {
            onClick: () => setFilterOpen((v) => !v),
            title: t("sm.filter"),
            style: {
              ...ghostBtn, fontSize: 11, position: "relative",
              background: activeFilterCount ? "rgba(99,102,241,0.18)" : undefined,
              borderColor: activeFilterCount ? "#6366f1" : undefined,
              color: activeFilterCount ? "#a5b4fc" : undefined,
            },
          }, `${activeFilterCount ? " " + activeFilterCount : ""}`),
          /* §14.3 stats drawer trigger */
          h("button", {
            onClick: () => { setStatsOpen((v) => !v); setFilterOpen(false); },
            title: t("sm.stats"),
            style: { ...ghostBtn, fontSize: 11, background: statsOpen ? "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 18%, transparent)" : undefined },
          }, "📊"),
          archStatus && archStatus.candidates.length > 0 && h("button", {
            onClick: () => void runArchiveNow(),
            disabled: archBusy,
            title: archStatus.candidates.map((c) => c.sessionId.slice(0, 8)).join(", "),
            style: { ...ghostBtn, color: "var(--warn, #f59e0b)", borderColor: "#f59e0b55", whiteSpace: "nowrap", fontSize: 10 },
          }, archBusy ? "…" : `${archStatus.candidates.length}`),
          archStatus && archStatus.cacheBytes > 0 && h("button", {
            onClick: async () => {
              const res = await fetch(apiUrl("/api/extensions/session-manager/archive/cache?clear=1"));
              if (res.ok) refreshArchStatus();
            },
            title: t("sm.clearCache"),
            style: { ...ghostBtn, fontSize: 10, whiteSpace: "nowrap" },
          }, `${(archStatus.cacheBytes / 1048576).toFixed(1)}M`),
          h("button", { onClick: () => panelOpen.onClose(), style: ghostBtn }, t("sm.close")),
        ),
        /* §14.2 filter menu (model / date / sort / role) */
        filterOpen && h("div", {
          style: { display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap", padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "rgba(99,102,241,0.05)" },
        },
          /* model */
          h("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 150 } },
            h("span", { style: { fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" } }, t("sm.model")),
            (stats?.byModel ?? []).slice(0, 12).map((m) => h("span", {
              key: m.model,
              onClick: () => setModelFilter(modelFilter === m.model ? "" : m.model),
              style: {
                cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                background: modelFilter === m.model ? "rgba(99,102,241,0.25)" : "var(--bg-hover)",
                color: modelFilter === m.model ? "#a5b4fc" : "var(--text-muted)",
              },
            }, `${m.model} · ${m.sessions}`)),
            (stats?.byModel ?? []).length === 0 && h("span", { style: { fontSize: 11, color: "var(--text-dim)" } }, "…"),
          ),
          /* date */
          h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("span", { style: { fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" } }, t("sm.date")),
            DATE_PRESETS.map((p) => h("span", {
              key: p.key,
              onClick: () => setDatePreset(datePreset === p.key ? "" : p.key),
              style: {
                cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                background: datePreset === p.key ? "rgba(99,102,241,0.25)" : "var(--bg-hover)",
                color: datePreset === p.key ? "#a5b4fc" : "var(--text-muted)",
              },
            }, p.label())),
            datePreset.startsWith("day:") && h("span", { style: { fontSize: 11, color: "#a5b4fc", background: "rgba(99,102,241,0.25)", padding: "1px 7px", borderRadius: 8, cursor: "pointer" }, onClick: () => setDatePreset("") },
              `${datePreset.slice(4)} ✖`),
          ),
          /* sort */
          h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("span", { style: { fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" } }, t("sm.sort")),
            ["modified", "created", "name", "messageCount"].map((k) => h("span", {
              key: k,
              onClick: () => { setSortBy(k); if (sortBy === k) setSortAsc((v) => !v); },
              style: {
                cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                background: sortBy === k ? "rgba(99,102,241,0.25)" : "var(--bg-hover)",
                color: sortBy === k ? "#a5b4fc" : "var(--text-muted)",
              },
            }, `${k === "messageCount" ? t("sm.msgCountLabel") : k}${sortBy === k ? (sortAsc ? " ↑" : " ↓") : ""}`)),
          ),
          /* role (search mode) + clear all */
          h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("span", { style: { fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" } }, t("sm.roleSearch")),
            ["user", "assistant", "toolResult"].map((r) => h("span", {
              key: r,
              onClick: () => setRoleFilter(roleFilter === r ? "" : r),
              style: {
                cursor: "pointer", fontSize: 11, padding: "1px 7px", borderRadius: 8, whiteSpace: "nowrap",
                background: roleFilter === r ? "rgba(99,102,241,0.25)" : "var(--bg-hover)",
                color: roleFilter === r ? "#a5b4fc" : "var(--text-muted)",
              },
            }, [roleBadge(r), " " + r])),
            h("button", {
              onClick: () => { setModelFilter(""); setRoleFilter(""); setDatePreset(""); setArchivedOnly(false); setFavOnly(false); sharedFilter.tagIds = []; notifyFilter(); },
              style: { ...ghostBtn, fontSize: 10, marginTop: 2 },
            }, t("sm.clearAll")),
          ),
        ),

        /* §14.3 stats drawer */
        statsOpen && h("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 5%, transparent)" } },
          !stats ? h("div", { style: { color: "var(--text-dim)", fontSize: 12 } }, "…") : h("div", null,
            /* 4 stat cards */
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              statCard("🧾", `${stats.totals.totalSessions}`, t("sm.sessions")),
              statCard("📦", `${stats.totals.archivedSessions}`, t("sm.archived")),
              statCard("💬", `${stats.totals.totalMessages}`, "消息"),
              statCard("⟳", `${stats.totals.runningSessions}`, "运行中"),
            ),
            h("div", { style: { display: "flex", gap: 16, marginTop: 8, alignItems: "flex-start", flexWrap: "wrap" } },
              /* model distribution */
              h("div", { style: { flex: 1, minWidth: 180 } },
                h("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 4 } }, t("sm.modelDist")),
                (stats.byModel ?? []).slice(0, 6).map((m) => {
                  const max = Math.max(1, ...(stats.byModel ?? []).map((x) => x.messages));
                  return h("div", { key: m.model, style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2, fontSize: 10 } },
                    h("span", { style: { minWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" } }, m.model),
                    h("div", { style: { flex: 1, height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden" } },
                      h("div", { style: { width: `${Math.round((m.messages / max) * 100)}%`, height: "100%", background: "var(--ok, #10b981)" } }),
                    ),
                    h("span", { style: { color: "var(--text-dim)" } }, String(m.messages)),
                  );
                }),
              ),
              /* heatmap — click a day to filter the list to that day */
              h("div", { style: { flex: 2, minWidth: 260 } },
                h("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 4 } }, t("sm.activityHint")),
                heatmapGrid(stats.heatmap, (day) => {
                  setDatePreset(`day:${day}`);
                  setStatsOpen(false);
                }),
                h("div", { style: { fontSize: 10, color: "var(--text-dim)", marginTop: 4, display: "flex", gap: 10 } },
                  t("sm.todayLine", { s: stats.totals.todaySessions, m: stats.totals.todayMessages }),
                  t("sm.weekLine", { n: stats.totals.weekMessages }),
                ),
              ),
            ),
          ),
        ),

        /* §14.4 batch bar */
        selection.size > 0 && h("div", {
          style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 12px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--warn, #f59e0b) 8%, transparent)" },
        },
          h("span", { style: { fontSize: 11, color: "var(--warn, #f59e0b)" } }, t("sm.selectedCount", { count: selection.size })),
          h("button", { disabled: batchBusy, onClick: () => void batchArchive(), style: ghostBtn }, `${t("sm.archive")}`),
          h("button", { disabled: batchBusy, onClick: () => void batchFavorite(), style: ghostBtn }, `${t("sm.favorite")}`),
          h("button", { disabled: batchBusy, onClick: () => void batchDelete(), style: { ...ghostBtn, color: "var(--danger, #f87171)" } }, `${t("sm.deleteArchive")}`),
          h("button", { onClick: () => setSelection(new Set()), style: { ...ghostBtn, marginLeft: "auto" } }, "清除"),
        ),

        /* tag filter chips — §4.2 counts (incl. descendants) + expandable parents */
        h("div", { style: { display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", padding: "6px 12px", borderBottom: "1px solid var(--border)", maxHeight: 110, overflowY: "auto" } },
          /* §14.2.5 active-filter chips (model / date / role) — visible even when the menu is closed */
          modelFilter && h("span", {
            onClick: () => setModelFilter(""),
            title: `${t("sm.clearAll")}`,
            style: { padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "rgba(99,102,241,0.25)", color: "#a5b4fc", border: "1px solid #6366f1" },
          }, `${modelFilter} ✖`),
          datePreset && h("span", {
            onClick: () => setDatePreset(""),
            title: `${t("sm.clearAll")}`,
            style: { padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "rgba(99,102,241,0.25)", color: "#a5b4fc", border: "1px solid #6366f1" },
          }, `${datePreset.startsWith("day:") ? datePreset.slice(4) : DATE_PRESETS.find((p) => p.key === datePreset)?.label() ?? datePreset} ✖`),
          roleFilter && h("span", {
            onClick: () => setRoleFilter(""),
            title: `${t("sm.clearAll")}`,
            style: { padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer", background: "rgba(99,102,241,0.25)", color: "#a5b4fc", border: "1px solid #6366f1" },
          }, [roleBadge(roleFilter), " " + roleFilter + " "]),
          h("span", {
            onClick: () => { sharedFilter.tagIds = []; notifyFilter(); },
            style: {
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: selectedTags.length === 0 ? "var(--bg-selected)" : "none",
              color: selectedTags.length === 0 ? "var(--text)" : "var(--text-muted)",
            },
          }, t("sm.allTags")),
          h("span", {
            onClick: () => setArchivedOnly((v) => !v),
            style: {
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: archivedOnly ? "rgba(139,92,246,0.25)" : "none",
              color: archivedOnly ? "#a78bfa" : "var(--text-dim)",
              border: `1px solid ${archivedOnly ? "#a78bfa" : "var(--border)"}`,
            },
          }, `${t("sm.archived")}${archivedCount ? " " + archivedCount : ""}`),
          h("span", {
            onClick: () => setFavOnly((v) => !v),
            style: {
              padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
              background: favOnly ? "color-mix(in srgb, var(--warn, #f59e0b) 25%, transparent)" : "none",
              color: favOnly ? "var(--warn, #f59e0b)" : "var(--text-dim)",
              border: `1px solid ${favOnly ? "var(--warn, #f59e0b)" : "var(--border)"}`,
            },
          }, `${t("sm.favorite")}`),
          data.tags.filter((t) => !t.parentId || !byId.has(t.parentId))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((root) => chipRow(root, 0)),
          h("button", {
            onClick: () => managerOpen.onOpen(),
            style: { marginLeft: "auto", ...ghostBtn, fontSize: 10 },
          }, t("sm.manageTags")),
        ),
        /* sections — content rendered one frame after the frame itself (T-1),
           and each list block is layout-isolated so row updates never reflow
           the whole dialog (T-2) */
        h("div", { style: { flex: 1, overflowY: "auto", padding: "8px 6px", contain: "layout style" } },
          filtered.length === 0 && h("div", { style: { padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 } },
            t("sm.noResults"),
            /* archived rows are hidden by default — surface them when they're
               the only thing filtered out (empty list / search hits) */
            !archivedOnly && archivedCount > 0 && h("div", {
              onClick: () => setArchivedOnly(true),
              style: { marginTop: 6, cursor: "pointer", color: "#a78bfa", fontSize: 11 },
            }, t("sm.archivedHidden", { count: archivedCount })),
          ),
          // T-1: rows mounted in the second frame — the overlay + frame + header
          // are already on screen, so the big list layout lands during the
          // frame's opacity transition instead of blocking the open click.
          !ready && filtered.length > 0 && h("div", { style: { padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 } }, t("sm.loading") ?? "…"),
          ready && section("fav", t("sm.favorites"), favoritePage, favorites.length, () => setFavLoaded((n) => n + SECTION_PAGE_SIZE)),
          ready && section("running", t("sm.running"), runningPage, runningList.length, () => setRunningLoaded((n) => n + SECTION_PAGE_SIZE)),
          ready && section("recent", t("sm.recent"), pageItems, completed.length, null),
        ),
        /* pagination */
        completed.length > PAGE_SIZE && h("div", {
          style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)" },
        },
          h("button", { disabled: pageClamped === 0, onClick: () => setPage(pageClamped - 1), style: ghostBtn }, t("sm.prev")),
          h("span", null, t("sm.pageOf", { page: pageClamped + 1, pages })),
          h("button", { disabled: pageClamped >= pages - 1, onClick: () => setPage(pageClamped + 1), style: ghostBtn }, t("sm.next")),
        ),
      ),
    );
  }

  /* ═══════════ TagManager (dialogs slot) ═══════════ */

  function TagManager() {
    const s = useStore();
    const [open, setOpen] = useState(managerOpen.value);
    useEffect(() => {
      const l = () => setOpen(managerOpen.value);
      managerOpen.subs.add(l);
      return () => managerOpen.subs.delete(l);
    }, []);
    const [filter, setFilter] = useState("");
    const [newPath, setNewPath] = useState("");
    const [busy, setBusy] = useState(false);

    if (!open) return null;
    const data = s.tagData ?? EMPTY_TAGS;
    const byId = byIdMap(data);
    const roots = data.tags.filter((t) => !t.parentId || !byId.has(t.parentId))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const usage = (id) => {
      // sessions tagged with id or a descendant
      const set = new Set();
      const collect = (nodeId) => {
        set.add(nodeId);
        data.tags.filter((t) => t.parentId === nodeId).forEach((t) => collect(t.id));
      };
      collect(id);
      let n = 0;
      for (const ids of Object.values(data.sessionTags)) if (ids.some((x) => set.has(x))) n++;
      return n;
    };

    const createTag = async () => {
      const path = newPath.trim();
      if (!path || busy) return;
      setBusy(true);
      const ok = await act("assign", { sessionId: "\u0000__manager", path }); // assign creates nodes; drop session mapping
      if (ok) {
        // remove the marker session mapping if it was created
        const marker = "\u0000__manager";
        const d = store.tagData;
        if (d && d.sessionTags[marker]) {
          const next = { ...d, sessionTags: { ...d.sessionTags } };
          delete next.sessionTags[marker];
          await act2Replace(next);
        }
        setNewPath("");
      }
      setBusy(false);
    };

    const act2Replace = async (next) => {
      const res = await fetch(apiUrl("/api/extensions/session-manager/session-tags"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (res.ok) { const d = await res.json(); store.tagData = d.data; emit(); }
      else await refreshTags();
    };

    const nodeRow = (node, depth) => {
      const path = tagPath(node.id, data);
      const count = usage(node.id);
      const visible = !filter || path.toLowerCase().includes(filter.toLowerCase());
      const children = data.tags.filter((t) => t.parentId === node.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      return [
        visible && h("div", {
          key: node.id,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 4px " + (10 + depth * 14) + "px", fontSize: 12 },
        },
          h("span", { style: { width: 9, height: 9, borderRadius: 3, background: node.color, flexShrink: 0 } }),
          h("span", { style: { color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11 } }, path),
          h("span", { style: { color: "var(--text-dim)", fontSize: 10, flexShrink: 0 } }, `${count}`),
          h("span", { style: { marginLeft: "auto", display: "flex", gap: 2, flexShrink: 0 } },
            h("input", {
              type: "color",
              value: node.color,
              title: t("sm.recolor"),
              onChange: (e) => void act("recolor", { tagId: node.id, color: e.target.value }),
              style: { width: 18, height: 18, padding: 0, border: "none", background: "none", cursor: "pointer" },
            }),
            h("button", {
              title: t("sm.resetColor"),
              onClick: () => {
                // §3.3 reset to the built-in default (common-name map / palette hash)
                const def = defaultColorForClient(node.name);
                if (def !== node.color) void act("recolor", { tagId: node.id, color: def });
              },
              style: miniBtn,
            }, "↺"),
            h("button", {
              title: t("sm.rename"),
              onClick: () => {
                const name = prompt(t("sm.rename"), node.name);
                if (name && name.trim() && name.trim() !== node.name) void act("rename", { tagId: node.id, name: name.trim() });
              },
              style: miniBtn,
            }, "✎"),
            h("button", {
              title: t("sm.newChild"),
              onClick: () => {
                const name = prompt(t("sm.newChild"), "");
                if (name && name.trim()) void act("assign", { sessionId: "\u0000__child", path: path + "/" + name.trim() });
              },
              style: miniBtn,
            }, "+"),
            h("button", {
              title: t("sm.delete"),
              onClick: () => {
                if (!confirm(t("sm.confirmDelete"))) return;
                const subtree = confirm(t("sm.confirmDeleteSubtree"));
                void act("delete", { tagId: node.id, subtree });
              },
              style: miniBtn,
            }, "🗑"),
          ),
        ),
        children.map((c) => nodeRow(c, depth + 1)),
      ];
    };

    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 295,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center",
      },
      onClick: () => managerOpen.onClose(),
    },
      h("div", {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: "min(520px, 92vw)", maxHeight: "76vh",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 14, overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        },
      },
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" } },
          h("strong", { style: { fontSize: 13 } }, t("sm.manageTags")),
          h("input", { value: filter, placeholder: t("sm.searchPlaceholder"), onChange: (e) => setFilter(e.target.value), style: inputStyle }),
          h("button", { onClick: () => managerOpen.onClose(), style: ghostBtn }, t("sm.close")),
        ),
        h("div", { style: { display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border)" } },
          h("input", { value: newPath, placeholder: t("sm.tagPlaceholder"), onChange: (e) => setNewPath(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") void createTag(); }, style: inputStyle }),
          h("button", { onClick: () => void createTag(), disabled: busy || !newPath.trim(), style: { ...ghostBtn, background: "var(--accent)", color: "#fff", borderStyle: "none" } }, t("sm.newTag")),
        ),
        h("div", { style: { flex: 1, overflowY: "auto", padding: "6px 0" } },
          roots.map((r) => nodeRow(r, 0)),
          data.tags.length === 0 && h("div", { style: { padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 } }, t("sm.noSessions")),
        ),
      ),
    );
  }

  /* ═══════════ Kanban page (pages slot) ═══════════ */

  function KanbanPage(props) {
    const s = useStore();
    const [open, setOpen] = useState(kanbanOpen.value);
    const [project, setProject] = useState(null); // null = all projects
    const [columns, setColumns] = useState([]); // tag ids as columns
    // §5.3.1 TagFilterBar: narrows sessions within columns (OR, tree-aware),
    // sharing the same tag set semantics as the columns.
    const filterTags = useSharedFilter();
    const [filterVisible, setFilterVisible] = useState(false);
    useEffect(() => {
      const l = () => setOpen(kanbanOpen.value);
      kanbanOpen.subs.add(l);
      return () => kanbanOpen.subs.delete(l);
    }, []);

    // refresh on open (external/multi-tab changes) — same fix as the panel
    useEffect(() => {
      if (!open) return;
      void refreshSessions();
      void refreshTags();
    }, [open]);

    // cross-view state: inherit the sidebar-selected project when it changes
    const syncedCwd = useRef(null);
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
      void refreshTags();
    }, []);

    // default columns = first 4 tags once loaded
    useEffect(() => {
      if (columns.length === 0 && s.tagData && s.tagData.tags.length > 0) {
        setColumns(s.tagData.tags.slice(0, Math.min(4, s.tagData.tags.length)).map((t) => t.id));
      }
    }, [s.tagData]);

    if (!open) return null;

    const data = s.tagData ?? EMPTY_TAGS;
    const byId = byIdMap(data);
    const projects = [...new Set(s.sessions.map((x) => x.projectRoot ?? x.cwd).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const tagList = [...data.tags].sort((a, b) => a.name.localeCompare(b.name));

    const sessionsInProject = project
      ? s.sessions.filter((x) => (x.projectRoot ?? x.cwd) === project)
      : s.sessions;
    const narrowed = filterTags.length
      ? sessionsInProject.filter((x) => matchesTags(x.id, data, filterTags))
      : sessionsInProject;

    const sessionsOfColumn = (tagId) => {
      const set = new Set(descendantsLocal(tagId, byId));
      const list = narrowed.filter((x) => sessionTagIds(x.id, data).some((tid) => set.has(tid)));
      return list.sort((a, b) => {
        const ra = s.running.has(a.id) ? 0 : 1;
        const rb = s.running.has(b.id) ? 0 : 1;
        return ra - rb || (b.modified ?? "").localeCompare(a.modified ?? "");
      });
    };

    const card = (sess) => h("div", {
      key: sess.id,
      onClick: () => {
        if (sess.archived) openViewer(sess.id);
        else { props.onSelectSession?.(sess); kanbanOpen.onClose(); }
      },
      style: {
        padding: "8px 10px", borderRadius: 9, cursor: "pointer",
        background: "var(--bg)", border: "1px solid var(--border)",
        marginBottom: 6,
      },
    },
      h("div", { style: { display: "flex", gap: 5, alignItems: "center" } },
        h("span", { style: { fontSize: 10, color: s.running.has(sess.id) ? "var(--accent)" : "var(--text-dim)" } },
          s.running.has(sess.id) ? "⟳" : sess.archived ? "📦" : ""),
        h("span", { style: { flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, sessionTitle(sess)),
        h(StarButton, {
          sessionId: sess.id,
          onToggle: (on) => void act(on ? "favorite" : "unfavorite", { sessionId: sess.id }),
        }),
      ),
      h("div", { style: { marginTop: 3, display: "flex", gap: 6, fontSize: 10, color: "var(--text-dim)" } },
        // §5.3.1: in "All projects" mode the card shows the project path
        h("span", { style: { fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          displayCwd(project ? sess.cwd : (sess.projectRoot ?? sess.cwd))),
        h("span", { style: { flexShrink: 0 } }, fmtRelative(sess.modified)),
      ),
    );

    const column = (tagId) => {
      const node = byId.get(tagId);
      if (!node) return null;
      const items = sessionsOfColumn(tagId);
      return h("div", {
        key: tagId,
        style: {
          width: 240, flexShrink: 0, maxHeight: "100%", overflowY: "auto",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 10, padding: 8, marginRight: 10,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 2px 8px" } },
          h("span", { style: { width: 9, height: 9, borderRadius: 3, background: node.color, flexShrink: 0 } }),
          h("span", { style: { fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, tagPath(tagId, data)),
          h("span", { style: { marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 } }, items.length),
        ),
        items.length === 0
          ? h("div", { style: { padding: 10, textAlign: "center", color: "var(--text-dim)", fontSize: 11 } }, t("sm.empty"))
          : items.map(card),
      );
    };

    return h("div", {
      style: {
        position: "absolute", inset: 0, zIndex: 40,
        background: "var(--bg)", display: "flex", flexDirection: "column",
      },
    },
      /* toolbar */
      h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" } },
        h("strong", { style: { fontSize: 13, whiteSpace: "nowrap" } }, t("sm.kanban")),
        h("select", {
          value: project ?? "",
          onChange: (e) => setProject(e.target.value || null),
          style: selectStyle,
        },
          h("option", { key: "__all__", value: "" }, t("sm.allProjects")),
          projects.map((p) => h("option", { key: p, value: p }, displayCwd(p))),
        ),
        h("span", { style: { fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" } }, t("sm.columns")),
        tagList.map((node) => h("span", {
          key: node.id,
          onClick: () => setColumns((prev) => prev.includes(node.id) ? prev.filter((x) => x !== node.id) : [...prev, node.id]),
          style: {
            padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
            background: columns.includes(node.id) ? node.color + "33" : "none",
            color: columns.includes(node.id) ? node.color : "var(--text-dim)",
            border: `1px solid ${columns.includes(node.id) ? node.color : "var(--border)"}`,
          },
        }, node.name)),
        h("span", { style: { marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" } },
          h("button", {
            onClick: () => setFilterVisible((v) => !v),
            style: { ...ghostBtn, color: filterTags.length ? "var(--accent)" : "var(--text-muted)" },
          }, `${t("sm.filter")}` + (filterTags.length ? ` (${filterTags.length})` : "")),
          h("button", { onClick: () => kanbanOpen.onClose(), style: ghostBtn }, t("sm.close")),
        ),
      ),
      /* §5.3.1 TagFilterBar — narrows sessions inside columns (OR, tree-aware) */
      filterVisible && h("div", { style: { display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", padding: "5px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" } },
        h("span", {
          onClick: () => { sharedFilter.tagIds = []; notifyFilter(); },
          style: {
            padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
            background: filterTags.length === 0 ? "var(--bg-selected)" : "none",
            color: filterTags.length === 0 ? "var(--text)" : "var(--text-muted)",
          },
        }, t("sm.allTags")),
        tagList.map((node) => h("span", {
          key: node.id,
          onClick: () => toggleSharedFilter(node.id),
          title: tagPath(node.id, data),
          style: {
            padding: "1px 8px", borderRadius: 9, fontSize: 10, cursor: "pointer",
            background: filterTags.includes(node.id) ? node.color + "33" : node.color + "1a",
            color: node.color,
            border: `1px solid ${filterTags.includes(node.id) ? node.color : node.color + "33"}`,
          },
        }, node.name)),
      ),
      /* columns */
      h("div", { style: { flex: 1, overflowX: "auto", display: "flex", alignItems: "flex-start", padding: "10px 8px" } },
        columns.map(column),
        columns.length === 0 && h("div", { style: { padding: 24, color: "var(--text-dim)", fontSize: 12 } },
          t("sm.noColumns")),
      ),
    );
  }

  function descendantsLocal(tagId, byIdMapRef) {
    const out = [tagId];
    let i = 0;
    while (i < out.length) {
      const p = out[i++];
      for (const t of byIdMapRef.values()) if (t.parentId === p && !out.includes(t.id)) out.push(t.id);
    }
    return out;
  }


  // ---- §3.4 pending 持久化：新会话 tag 只存 React state 会在刷新/重挂载时丢
  //   （标签既没附到 session 也没附到新 session）——落 localStorage（按 cwd 分组），
  //   会话创建（含刷新恢复）后合并到真实 sessionId，全部成功才清存储。
  const PENDING_TAGS_KEY = "sm.pendingTags.v1"; // { [cwd]: string[] }
  function loadPendingMap() { try { return JSON.parse(localStorage.getItem(PENDING_TAGS_KEY) || "{}") || {}; } catch { return {}; } }
  function savePendingMap(map) { try { localStorage.setItem(PENDING_TAGS_KEY, JSON.stringify(map)); } catch { /* ignore */ } }

  function TopbarTags(props) {
    const s = useStore();
    // 数据刷新：会话切换 + 定时轮询 + 回到前台——跨 tab/跨实例的修改能反映到 chip（否则长期显示旧数据）
    useEffect(() => {
      void refreshTags();
      const iv = setInterval(() => void refreshTags(), 5000);
      const onVis = () => { if (!document.hidden) void refreshTags(); };
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("focus", onVis);
      return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
    }, [props.currentSession?.id]);
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState("");
    const [suggestions, setSuggestions] = useState([]);
    const [pickPos, setPickPos] = useState(null); // fixed-position picker popover
    const editRef = useRef(null); // 编辑器容器（输入框/建议/TagPicker 弹层）——点击外部才关闭
    // 点击编辑区外关闭。不能依赖输入框 onBlur：真实点击标签树行/搜索框时浏览器先移焦 → blur →
    // 编辑器整体卸载（菜单先消失），click 事件到不了标签行，标签选不上。改用 document mousedown
    // 判断目标是否在编辑器内：内部点击（选标签/搜索/▦/⚙/新建）一律不关，外部点击才关。
    useEffect(() => {
      if (!editing) return;
      const onDown = (e) => {
        if (editRef.current && editRef.current.contains(e.target)) return;
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
    const tagIds = session ? sessionTagIds(session.id, data) : [];

    // §3.4: 新会话 tag 落 localStorage（按 cwd）——刷新/重挂载不丢；会话创建（含刷新恢复）后合并。
    const [pending, setPending] = useState(() => {
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
    const mergedCwdRef = useRef(null);
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

    const tagCtx = { data, s, act, t };

    // §3.4 autocomplete: suggest existing tag paths matching the input
    useEffect(() => {
      const q = input.trim().toLowerCase();
      if (!q || !editing) { setSuggestions([]); return; }
      const byId = byIdMap(data);
      const all = data.tags.map((n) => ({ id: n.id, path: tagPath(n.id, data) }))
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

    const pickSuggestion = (path) => { setInput(path); setSuggestions([]); };

    // ⋯ 下拉（menu）模式：与其他菜单项统一为「36px 图标槽 + 右竖线」——不渲染完整 widget，
    // 点击打开标签管理器（顶栏/会话内仍是完整 tag widget）。位置在所有 hooks 之后。
    if (props?.menu === true) {
      return h("div", {
        role: "button", tabIndex: 0,
        style: { display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, flexShrink: 0, borderRight: "1px solid var(--border)", cursor: "pointer" },
        onClick: () => managerOpen.onOpen(),
        onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); managerOpen.onOpen(); } },
        title: t("sm.tags"),
      },
        h("svg", {
          width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
          strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
        },
          h("path", { key: "p1", d: "M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42z" }),
          h("line", { key: "p2", x1: 7, y1: 7, x2: 7.01, y2: 7 })),
      );
    }

    return h("span", {
      style: {
        display: "flex", alignItems: "center", gap: 4,
        padding: "0 8px", fontSize: 11, color: "var(--text-muted)",
        whiteSpace: "nowrap", overflow: "hidden", flexShrink: 0, position: "relative",
      },
    },
      h("span", { style: { color: "var(--text-dim)", marginRight: 2 } }, t("sm.tags")),
      session && h("button", {
        title: fav ? t("sm.unfavorite") : t("sm.favorite"),
        onClick: () => void act(fav ? "unfavorite" : "favorite", { sessionId: session.id }),
        style: { background: "none", border: "none", cursor: "pointer", color: fav ? "var(--warn, #f59e0b)" : "var(--text-dim)", fontSize: 12, padding: 0 },
      }, fav ? "★" : "☆"),
      /* §3.4: chips are clickable — add to the panel filter（上限 2 个 + 计数：窄顶栏行也能保持 tag 区可见） */
      (isNewSession ? pending : tagIds).slice(0, 2).map((tidOrPath) => {
        if (isNewSession) {
          return h("span", {
            key: tidOrPath,
            title: tidOrPath,
            style: { padding: "1px 7px", borderRadius: 9, fontSize: 10, background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)" },
          }, "⌛" + tidOrPath.split("/").pop());
        }
        // §3.4: chips removable (×) + click adds to the panel filter
        return h(TagChip, {
          key: tidOrPath, tagId: tidOrPath, data,
          onClick: () => toggleSharedFilter(tidOrPath),
          onRemove: () => void act("unassign", { sessionId: session.id, tagId: tidOrPath }),
        });
      }),
      (isNewSession ? pending : tagIds).length > 2 && h("span", { style: { fontSize: 10, color: "var(--text-dim)" } }, `+${(isNewSession ? pending : tagIds).length - 2}`),
      isNewSession && h("span", { style: { fontSize: 10, color: "var(--warn, #f59e0b)" } }, "新建会话"),
      editing ? (
        h("span", { ref: editRef, style: { position: "relative", display: "inline-flex" } },
          h("input", {
            autoFocus: true,
            value: input,
            placeholder: t("sm.tagPlaceholder"),
            onChange: (e) => setInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") { setEditing(false); setSuggestions([]); setPickPos(null); }
            },
            style: { width: 130, fontSize: 10, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--bg)", color: "var(--text)", outline: "none" },
          }),
          suggestions.length > 0 && h("div", {
            style: {
              position: "absolute", top: "calc(100% + 2px)", left: 0, zIndex: 320,
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 7,
              boxShadow: "0 6px 18px rgba(0,0,0,0.25)", overflow: "hidden", minWidth: 140,
            },
          },
            suggestions.map((sg) => h("div", {
              key: sg.id,
              onMouseDown: (e) => { e.preventDefault(); pickSuggestion(sg.path); },
              style: {
                padding: "5px 10px", fontSize: 11, cursor: "pointer", color: "var(--text)",
                fontFamily: "var(--font-mono)", background: "var(--bg)",
              },
            }, sg.path)),
          ),
          /* §3.4: pick from the tag tree (选择) or keep typing (输入) */
          h("button", {
            title: t("sm.chooseTag"),
            onMouseDown: (e) => e.preventDefault(),
            onClick: (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPickPos({ top: r.bottom + 4, left: Math.max(8, r.right - 240) });
            },
            style: {
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-dim)", fontSize: 12, padding: "0 3px",
            },
          }, "▦"),
          /* §3.4: tag-manager entry from the editor */
          h("button", {
            title: t("sm.manageTags"),
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => { setEditing(false); managerOpen.onOpen(); },
            style: {
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-dim)", fontSize: 11, padding: "0 3px",
            },
          }, "⚙"),
          pickPos && h(TagPicker, {
            position: pickPos,
            onPick: (tagId) => {
              // opened session → assign directly; new session → pending path
              if (isNewSession) {
                const path = tagPath(tagId, data);
                setPending((p) => (p.includes(path) ? p : [...p, path]));
              } else if (session) {
                void act("assignTag", { sessionId: session.id, tagId });
              }
              setPickPos(null);
            },
          }),
        )
      ) : (
        h("button", {
          title: t("sm.addTag"),
          onClick: (e) => {
            setEditing(true);
            // user req: the tag picker opens automatically with the editor
            const r = e.currentTarget.getBoundingClientRect();
            setPickPos({ top: r.bottom + 4, left: Math.max(8, r.right - 240) });
          },
          style: { background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 13, padding: "0 2px" },
        }, "+")
      ),
    );
  }

  /* ═══════════ sessionRowActions: favorite star + inline tag edit + archive (§4.1) ═══════════ */

  function RowActions(props) {
    const s = useStore();
    const [rowBusy, setRowBusy] = useState(new Set());
    const isBusy = (id) => rowBusy.has(id);
    const markBusy = (id) => setRowBusy((prev) => new Set(prev).add(id));
    const markDone = (id) => setRowBusy((prev) => { const n = new Set(prev); n.delete(id); return n; });
    useEffect(() => { void refreshTags(); }, []);
    const session = props.currentSession;
    if (!session) return null;
    const data = s.tagData ?? EMPTY_TAGS;
    const fav = !!s.tagData && data.favoriteIds.includes(session.id);
    /* sidebar rows are live core sessions — running ones can't be archived (server enforces too) */
    const canArchive = !s.running.has(session.id);
    return h("span", { style: { display: "flex", gap: 4, alignItems: "center" } },
      h("button", {
        title: fav ? t("sm.unfavorite") : t("sm.favorite"),
        onClick: (e) => { e.stopPropagation(); void act(fav ? "unfavorite" : "favorite", { sessionId: session.id }); },
        style: {
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 32, height: 32, padding: 0,
          background: "var(--bg-hover)", border: "1px solid var(--border)",
          borderRadius: 7, cursor: "pointer", flexShrink: 0,
          color: fav ? "var(--warn, #f59e0b)" : "var(--text-muted)",
        },
      }, fav ? "★" : "☆"),
      h(TagEditPopover, { sessionId: session.id }),
      canArchive && h("button", {
        title: isBusy(session.id) ? t("sm.archiving") ?? "归档中…" : t("sm.archive"),
        disabled: isBusy(session.id),
        onClick: (e) => {
          e.stopPropagation();
          if (isBusy(session.id)) return;
          markBusy(session.id);
          void archiveSession(session.id).finally(() => markDone(session.id));
        },
        style: {
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 32, height: 32, padding: 0, fontSize: 13,
          background: "var(--bg-hover)", border: "1px solid var(--border)",
          borderRadius: 7, cursor: "pointer", flexShrink: 0,
          color: "var(--text-muted)",
        },
      }, isBusy(session.id) ? "⟳" : "📦"),
    );
  }


  function SidebarEntry() {
    const s = useStore();
    useEffect(() => {
      // 运行徽标只需 running 集合：轻量轮询 agent/running（~10ms），不拉 sessions 全量
      void refreshRunning();
      const iv = setInterval(() => void refreshRunning(), 5000);
      return () => clearInterval(iv);
    }, []);
    const runningCount = s.running.size;
    return h("button", {
      title: t("sm.allSessions"),
      onClick: () => panelOpen.onOpen(),
      style: {
        display: "flex", alignItems: "center", gap: 5,
        height: 30, padding: "0 10px", marginRight: 6,
        background: "var(--bg-hover)", border: "1px solid var(--border)",
        borderRadius: 7, color: "var(--text-muted)", cursor: "pointer",
        fontSize: 11, flexShrink: 0,
      },
    },
      h("svg", { key: "ico", width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { key: "p1", d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }),
        h("path", { key: "p2", d: "M13 8H7" }),
        h("path", { key: "p3", d: "M17 12H7" })),
      runningCount > 0 && h("span", { key: "cnt",
        style: {
          minWidth: 16, padding: "0 4px", borderRadius: 8, textAlign: "center",
          background: "rgba(37,99,235,0.18)", color: "var(--accent)", fontSize: 10,
        },
      }, String(runningCount)),
    );
  }

  function ToolbarEntry() {
    return h("button", {
      title: t("sm.allSessions"),
      onClick: () => panelOpen.onOpen(),
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    },
      // lucide message-square-text：气泡+文本行（会话列表）——与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { key: "p1", d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }),
        h("path", { key: "p2", d: "M13 8H7" }),
        h("path", { key: "p3", d: "M17 12H7" }),
      ));
  }

  function KanbanEntry() {
    return h("button", {
      title: t("sm.kanban"),
      onClick: () => kanbanOpen.onOpen(),
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    },
      // lucide kanban：三条竖列线——看板语义，与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { key: "p1", d: "M6 5v11" }),
        h("path", { key: "p2", d: "M12 5v6" }),
        h("path", { key: "p3", d: "M18 5v14" }),
      ));
  }

  /* ═══════════ registration ═══════════ */

  /* 顶栏会话搜索框：输入 + 点搜索/回车 → 打开全部会话面板并执行搜索（面板内已有搜索能力）。
   * menu（⋯ 下拉）= true：渲染真实输入框（窄版）——行内放不下被挤进 ⋯ 时，用户仍可直接输入；
   * 输入框内点击不关菜单（宿主菜单已对 input/textarea 放行），回车/点搜索 → 打开面板并搜索。 */
  function ToolbarSearch(props) {
    const { menu } = props || {};
    const [val, setVal] = useState("");
    const submit = () => {
      const q = val.trim();
      pendingSearch = q;
      panelOpen.onOpen();
    };
    if (menu) {
      // 菜单布局与其他条目一致：图标 36px 槽 + 右竖线（borderRight），输入框在竖线右边；
      // 已自带图标+输入+按钮，宿主不再补 label（meta.noMenuLabel）。输入框内点击不关菜单（宿主已放行 input）。
      return h("div", {
        style: { display: "flex", alignItems: "center", height: 36, flexShrink: 0 },
      },
        h("div", {
          style: {
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, flexShrink: 0,
            borderRight: "1px solid var(--border)", color: "var(--text-muted)",
          },
          title: t("sm.search"),
        },
          h("svg", {
            width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
            strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
          },
            h("circle", { cx: 11, cy: 11, r: 8 }),
            h("line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })),
        ),
        h("div", {
          style: { display: "flex", alignItems: "center", gap: 5, padding: "0 8px", height: 36, flexShrink: 0 },
        },
          h("input", {
            value: val,
            onChange: (e) => setVal(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") submit(); },
            placeholder: t("sm.searchPlaceholder"),
            title: t("sm.searchPlaceholder"),
            style: {
              width: 140, height: 28, padding: "0 8px", boxSizing: "border-box",
              border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
            },
          }),
          h("button", {
            type: "button",
            onClick: submit,
            title: t("sm.search"),
            style: {
              height: 28, padding: "0 10px", flexShrink: 0,
              background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
              color: "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
            },
          }, t("sm.search")),
        ),
      );
    }
    return h("div", {
      style: { display: "flex", alignItems: "center", gap: 5, padding: "0 8px", height: 36, flexShrink: 0 },
    },
      h("div", { style: { position: "relative", display: "flex", alignItems: "center" } },
        h("svg", {
          width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
          strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
          style: { position: "absolute", left: 8, pointerEvents: "none", color: "var(--text-dim)" },
        },
          h("circle", { cx: 11, cy: 11, r: 8 }),
          h("line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 })),
        h("input", {
          value: val,
          onChange: (e) => setVal(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") submit(); },
          placeholder: t("sm.searchPlaceholder"),
          title: t("sm.searchPlaceholder"),
          style: {
            width: 160, height: 28, padding: "0 8px 0 24px", boxSizing: "border-box",
            border: "1px solid var(--border)", borderRadius: 6,
            background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
          },
        }),
      ),
      h("button", {
        type: "button",
        onClick: submit,
        title: t("sm.search"),
        style: {
          height: 28, padding: "0 10px", flexShrink: 0,
          background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
          color: "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
        },
      }, t("sm.search")),
    );
  }

  ctx.registerItems("pages", [{ id: "kanban", render: KanbanPage }]);

  ctx.registerItems("sidebar", [{ id: "sessions", render: SidebarEntry }]);
  ctx.registerItems("toolbar", [
    { id: "sessions", render: ToolbarEntry, meta: { label: "全部会话" } },
    { id: "search", render: ToolbarSearch, meta: { label: "搜索会话", noMenuLabel: true } },
    { id: "kanban", render: KanbanEntry, meta: { label: "看板" } },
  ]);
  ctx.registerItems("dialogs", [
    { id: "panel", render: SessionsPanel },
    { id: "archived-viewer", render: ArchivedViewer },
    { id: "tags-manager", render: TagManager },
  ]);
  ctx.registerItems("sessionTopbar", [{ id: "tags", render: TopbarTags, meta: { label: "标签" } }]);
  ctx.registerItems("sessionRowActions", [{ id: "actions", render: RowActions }]);
}

const inputStyle = {
  flex: 1, minWidth: 0, fontSize: 12, padding: "5px 9px",
  border: "1px solid var(--border)", borderRadius: 7, outline: "none",
  background: "var(--bg)", color: "var(--text)", boxSizing: "border-box",
};

const ghostBtn = {
  padding: "4px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer",
  background: "var(--bg-hover)", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)",
  color: "var(--text-muted)", whiteSpace: "nowrap",
};

const miniBtn = {
  background: "none", border: "none", cursor: "pointer",
  color: "var(--text-dim)", fontSize: 11, padding: "1px 4px",
};

const selectStyle = {
  fontSize: 11, padding: "3px 8px", borderRadius: 7,
  border: "1px solid var(--border)", background: "var(--bg)",
  color: "var(--text)", maxWidth: 220, outline: "none",
};

/**
 * session-manager · 标签管理器（树形 + 颜色/重命名/子标签/删除）。
 * 自手写版迁移，交互一比一。
 */
import { useState, useEffect } from "react";
import { t, apiUrl } from "./host-shim";
import { store, useStore, managerOpen, act, emit, ensureTags, refreshTags, EMPTY_TAGS } from "./store";
import { byIdMap, tagPath, defaultColorForClient, inputStyle, ghostBtn, miniBtn, SIc } from "./helpers";
import { uiConfirm, uiPrompt } from "../../../_shared/ui-dialogs";

export function TagManager() {
  const s = useStore();
  const [open, setOpen] = useState(managerOpen.value);
  useEffect(() => {
    const l = () => setOpen(managerOpen.value);
    managerOpen.subs.add(l);
    return () => { managerOpen.subs.delete(l); };
  }, []);
  // 打开即真正使用 tag 树 → 首次懒加载（后续变更由 event-bus 帧驱动）
  useEffect(() => { if (open) void ensureTags(); }, [open]);
  const [filter, setFilter] = useState("");
  const [newPath, setNewPath] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;
  const data = s.tagData ?? EMPTY_TAGS;
  const byId = byIdMap(data);
  const roots = data.tags.filter((n: any) => !n.parentId || !byId.has(n.parentId))
    .sort((a: any, b: any) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const usage = (id: string) => {
    // sessions tagged with id or a descendant
    const set = new Set<string>();
    const collect = (nodeId: string) => {
      set.add(nodeId);
      data.tags.filter((n: any) => n.parentId === nodeId).forEach((n: any) => collect(n.id));
    };
    collect(id);
    let n = 0;
    for (const ids of Object.values(data.sessionTags)) if ((ids as string[]).some((x) => set.has(x))) n++;
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

  const act2Replace = async (next: unknown) => {
    const res = await fetch(apiUrl("/api/extensions/session-manager/session-tags"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    if (res.ok) { const d = await res.json(); store.tagData = d.data; emit(); }
    else await refreshTags();
  };

  const nodeRow = (node: any, depth: number): any[] => {
    const path = tagPath(node.id, data);
    const count = usage(node.id);
    const visible = !filter || path.toLowerCase().includes(filter.toLowerCase());
    const children = data.tags.filter((n: any) => n.parentId === node.id)
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return [
      visible && (
        <div
          key={node.id}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 4px " + (10 + depth * 14) + "px", fontSize: 12 }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 3, background: node.color, flexShrink: 0 }} />
          <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11 }}>{path}</span>
          <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{`${count}`}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 2, flexShrink: 0 }}>
            <input
              type="color"
              value={node.color}
              title={t("sm.recolor")}
              onChange={(e) => void act("recolor", { tagId: node.id, color: e.target.value })}
              style={{ width: 18, height: 18, padding: 0, border: "none", background: "none", cursor: "pointer" }}
            />
            <button
              title={t("sm.resetColor")}
              onClick={() => {
                // §3.3 reset to the built-in default (common-name map / palette hash)
                const def = defaultColorForClient(node.name);
                if (def !== node.color) void act("recolor", { tagId: node.id, color: def });
              }}
              style={miniBtn}
            >↺</button>
            <button
              title={t("sm.rename")}
              onClick={async () => {
                const name = await uiPrompt({ message: t("sm.rename"), value: node.name });
                if (name && name.trim() && name.trim() !== node.name) void act("rename", { tagId: node.id, name: name.trim() });
              }}
              style={miniBtn}
            >✎</button>
            <button
              title={t("sm.newChild")}
              onClick={async () => {
                const name = await uiPrompt({ message: t("sm.newChild"), value: "" });
                if (name && name.trim()) void act("assign", { sessionId: "\u0000__child", path: path + "/" + name.trim() });
              }}
              style={miniBtn}
            >+</button>
            <button
              title={t("sm.delete")}
              onClick={async () => {
                if (!(await uiConfirm({ message: t("sm.confirmDelete"), danger: true }))) return;
                const subtree = await uiConfirm({ message: t("sm.confirmDeleteSubtree"), danger: true });
                void act("delete", { tagId: node.id, subtree });
              }}
              style={miniBtn}
            ><SIc name="trash" size={12} /></button>
          </span>
        </div>
      ),
      ...children.map((c: any) => nodeRow(c, depth + 1)),
    ];
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 295,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center",
      }}
      onClick={() => managerOpen.onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // aiti-float 浮动契约：拖拽/缩放/位置持久化/自动最大化按钮；小屏全屏。
        // style 尺寸保留作未装 aiti-float 时的兜底居中弹窗。
        data-ext-float="1" data-ext-float-w={520} data-ext-float-h={560} data-ext-float-full="1"
        style={{
          width: "min(520px, 92vw)", height: "min(70vh, 560px)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 14, overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 13 }}>{t("sm.manageTags")}</strong>
          <input value={filter} placeholder={t("sm.searchPlaceholder")} onChange={(e) => setFilter(e.target.value)} style={inputStyle as React.CSSProperties} />
          <button onClick={() => managerOpen.onClose()} aria-label={t("sm.close")} title={t("sm.close")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 } as React.CSSProperties}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <input value={newPath} placeholder={t("sm.tagPlaceholder")} onChange={(e) => setNewPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createTag(); }} style={inputStyle as React.CSSProperties} />
          <button onClick={() => void createTag()} disabled={busy || !newPath.trim()} style={{ ...ghostBtn, background: "var(--accent)", color: "#fff", border: "none" } as React.CSSProperties}>{t("sm.newTag")}</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 0" }}>
          {roots.map((r: any) => nodeRow(r, 0))}
          {data.tags.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("sm.noSessions")}</div>}
        </div>
      </div>
    </div>
  );
}

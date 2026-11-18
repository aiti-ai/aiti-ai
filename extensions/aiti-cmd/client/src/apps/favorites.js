/**
 * aiti-cmd client · 命令收藏 app (aiti-cmd-favorites)
 *
 * Command assets only: groups / search / tags / dictionary / CRUD / duplicate / schedule /
 * delete, plus the run action (which hands off to the terminal app). The two nested edit
 * dialogs (command, group) live here — they belong to this app's domain.
 */
import { btnStyle, rowStyle, inputStyle, smallStyle, SANDBOX_ORDER } from "../kit.js";
import { uiConfirm, uiAlert, uiPrompt } from "../../../../_shared/ui-dialogs";

export function createFavoritesApp(kit, store, deps) {
  const { h, t, api, apiUrl, Ic, ICONS, useState, useEffect } = kit;
  const { CmdWindow, useStore, SANDBOX } = deps;

  return function FavoritesApp() {
    const st = useStore();
    const open = !!st.open.favorites;
    const [commands, setCommands] = useState([]);
    const [groups, setGroups] = useState([]);
    const [q, setQ] = useState("");
    const [activeTag, setActiveTag] = useState(null);
    const [collapsed, setCollapsed] = useState({});
    const [editing, setEditing] = useState(null);
    const [editingGroup, setEditingGroup] = useState(null);
    const [dictOpen, setDictOpen] = useState(false);
    const [dictData, setDictData] = useState(null);
    const [dictText, setDictText] = useState("");
    const [err, setErr] = useState(null);
    const [tick, setTick] = useState(0);
    const [focusId, setFocusId] = useState(null);
    const refresh = () => { setTick((x) => x + 1); };

    const load = () => {
      fetch(api("/commands")).then((r) => r.json()).then((d) => { setCommands(d.commands || []); setGroups(d.groups || []); }).catch(() => {});
    };
    useEffect(() => { if (open) load(); }, [open, tick]);
    // external payloads: `create` (from the terminal ★ / share sink) → prefill the new-command form;
    // `focus` (after a save from the share dialog) → highlight the row, then clear the marker
    useEffect(() => {
      if (!open) return;
      const payload = st.favorites;
      if (payload && payload.create) {
        const c = payload.create;
        setEditingGroup(null);
        setEditing({ name: "", cmd: String(c.cmd || ""), cwd: c.cwd || "", tags: "", confirm: false, groupId: null, sandbox: "none", suggest: true });
        store.setIn("favorites", { create: null });
        setTimeout(() => { try { document.getElementById("aiti-cmd-edit-cmd")?.focus(); } catch {} }, 60);
      }
      if (payload && payload.focus) {
        setFocusId(payload.focus);
        store.setIn("favorites", { focus: null });
        const timer = setTimeout(() => setFocusId(null), 4000);
        return () => clearTimeout(timer);
      }
    }, [open, st.favorites.create, st.favorites.focus]);

    const loadDict = async () => {
      const d = await fetch(api("/commands/dict")).then((r) => r.json()).catch(() => null);
      if (d) { setDictData(d); setDictText((d.user && d.user.extra || []).join("\n")); }
    };

    // run one command: fill {params} placeholders, then confirm danger commands with a one-shot token
    const runWithConfirm = async (payload) => {
      let r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
      if (r.needConfirm) {
        const ok = await uiConfirm({ message: `${t("cmd.k311")}${r.danger && r.danger.length ? "（" + r.danger.join("/") + "）" : ""}？`, detail: `$ ${payload.command}`, danger: true });
        if (!ok) return null;
        r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, confirmToken: r.confirmToken }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
      }
      return r;
    };
    const runCommand = async (item) => {
      const params = item.params || [];
      const filled = {};
      if (params.length) {
        for (const p of params) { const v = await uiPrompt({ message: `${t("cmd.k151")}${p}：` }); if (v == null) return; filled[p] = v; }
      }
      let cmd = item.cmd;
      for (const [k, v] of Object.entries(filled)) cmd = cmd.replaceAll("{" + k + "}", v);
      const r = await runWithConfirm({ command: cmd, cwd: item.cwd, name: item.name, source: "favorite", commandId: item.id, confirm: !!item.confirm, sandbox: item.sandbox || "none" });
      if (!r) return;
      if (!r.ok) { setErr(r.error || t("cmd.k366")); return; }
      if (r.queued) setErr(t("cmd.k200") + r.position + "/" + r.maxConcurrent + t("cmd.k16"));
      store.openApp("terminal", { sessionId: r.sessionId, title: item.name || item.cmd });
      refresh();
    };
    const saveEditing = async () => {
      if (!editing || !editing.cmd.trim()) return;
      // normalize payload: tags comma string → array; empty cwd dropped (create uses ||undefined)
      const payload = { ...editing, tags: (editing.tags || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
      if (!payload.cwd) delete payload.cwd;
      if (editing.id) {
        await fetch(api("/commands/" + editing.id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
      } else {
        await fetch(api("/commands"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, name: editing.name.trim() || editing.cmd, source: "manual" }) }).catch(() => {});
      }
      setEditing(null); refresh();
    };
    const saveGroupEditing = async () => {
      if (!editingGroup || !editingGroup.name.trim()) return;
      if (editingGroup.id) {
        await fetch(api("/commands/groups/" + editingGroup.id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: editingGroup.name, parentId: editingGroup.parentId }) }).catch(() => {});
      } else {
        await fetch(api("/commands/groups"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: editingGroup.name, parentId: editingGroup.parentId }) }).catch(() => {});
      }
      setEditingGroup(null); refresh();
    };
    const miniBtn = { ...btnStyle, padding: "1px 7px", fontSize: 13 };
    const miniBtnDanger = { ...miniBtn, color: "var(--danger, #ef4444)" };
    // duplicate: copy to clipboard and reopen the new-command form prefilled
    const copyAsNew = (c) => {
      try {
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(c.cmd).catch(() => {});
        else {
          const ta = document.createElement("textarea");
          ta.value = c.cmd; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch {}
          document.body.removeChild(ta);
        }
      } catch {}
      setEditingGroup(null); // mutually exclusive dialogs
      setEditing({ name: c.name, cmd: c.cmd, cwd: c.cwd || "", tags: (c.tags || []).join(","), confirm: !!c.confirm, groupId: c.groupId || null, sandbox: c.sandbox || "none", suggest: c.suggest !== false });
      setTimeout(() => { try { document.getElementById("aiti-cmd-edit-cmd")?.focus(); } catch {} }, 60);
    };
    // ⏰ schedule: delegate to the aiti-ai-schedule extension (prefilled), else create a disabled plan
    const scheduleCommand = async (c) => {
      if (c.confirm && !(await uiConfirm({ message: `${t("cmd.k170")}${c.name || c.cmd}${t("cmd.k64")}`, danger: true }))) return;
      const prefill = {
        name: (c.name || c.cmd || t("cmd.k191")).slice(0, 60),
        prompt: t("cmd.k226") + (c.cwd ? t("cmd.k389") + c.cwd + "）" : "") + "：\n$ " + c.cmd + "\n完成后简要汇报输出要点与退出码。" + (c.params && c.params.length ? "\n注意：命令含 {参数} 占位符，请按当前上下文合理填充后再执行。" : ""),
        cwd: c.cwd || undefined,
        mode: "session",
      };
      try {
        if (typeof window.__aitiAiScheduleOpen === "function") { window.__aitiAiScheduleOpen(prefill); return; }
      } catch {}
      fetch(apiUrl("/api/extensions/aiti-ai-schedule/plans"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...prefill, schedule: "0 9 * * *", enabled: false, autoApprove: false }),
      }).then((r) => r.json()).then((d) => {
        if (d && d.ok) void uiAlert({ message: `${t("cmd.k199")}${prefill.name}${t("cmd.k65")}`, kind: "success" });
        else void uiAlert({ message: t("cmd.k121") + ((d && d.error) || t("cmd.k279")), kind: "error" });
      }).catch((e) => void uiAlert({ message: t("cmd.k121") + String(e), kind: "error" }));
    };

    if (!open) return null;

    const filtered = commands.filter((c) => (!q || (c.name + " " + c.cmd).toLowerCase().includes(q.toLowerCase())) && (!activeTag || (c.tags || []).includes(activeTag)));
    const allTags = Array.from(new Set(commands.flatMap((c) => c.tags || []))).sort();
    const childrenOf = (pid) => groups.filter((g) => g.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
    const commandsOf = (gid) => filtered.filter((c) => c.groupId === gid);
    const ungrouped = filtered.filter((c) => !c.groupId);
    const groupPathOf = (id) => {
      if (!id) return t("cmd.k277");
      const parts = []; let cur = groups.find((g) => g.id === id); let guard = 0;
      while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? groups.find((g) => g.id === cur.parentId) : undefined; }
      return parts.join(" / ") || t("cmd.k277");
    };

    const renderCommandRow = (c, depth) =>
      h("div", { key: c.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid " + (focusId === c.id ? "var(--accent)" : "var(--border)"), marginLeft: depth * 18 } },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 14, fontWeight: 600 } }, c.name + (c.confirm ? " ⚠" : "") + (SANDBOX[c.sandbox || "none"] ? SANDBOX[c.sandbox || "none"].icon : "")),
          h("code", { style: { fontSize: 13, color: "var(--text-muted)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + c.cmd + (c.cwd ? "  ·  " + c.cwd : "")),
        ),
        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, "×" + (c.runCount || 0)),
        h("button", { onClick: () => runCommand(c), style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none" }, title: t("cmd.k59") + (c.params && c.params.length ? t("cmd.k388") : "") + (c.confirm ? t("cmd.k386") : "") }, Ic(13, ICONS.play), t("cmd.k225")),
        h("button", { onClick: () => copyAsNew(c), style: btnStyle, title: t("cmd.k183") }, "⧉"),
        h("button", { onClick: () => scheduleCommand(c), style: btnStyle, title: t("cmd.k192") }, "⏰"),
        h("button", { onClick: () => setEditing({ id: c.id, name: c.name, cmd: c.cmd, cwd: c.cwd || "", tags: (c.tags || []).join(","), confirm: !!c.confirm, groupId: c.groupId || null, sandbox: c.sandbox || "none", suggest: c.suggest !== false }), style: btnStyle, title: t("cmd.k333") }, Ic(13, ICONS.pencil)),
        h("button", { onClick: () => { fetch(api("/commands/" + c.id), { method: "DELETE" }).then(() => refresh()); }, style: miniBtnDanger, title: t("cmd.k130") }, Ic(13, ICONS.trash)),
      );
    const renderGroupTree = (parentId, depth) => {
      const rows = [];
      const newCmdInGroup = (gid) => {
        setEditingGroup(null);
        setEditing({ name: "", cmd: "", cwd: "", tags: "", confirm: false, groupId: gid, sandbox: "none", suggest: true });
        setTimeout(() => { try { document.getElementById("aiti-cmd-edit-cmd")?.focus(); } catch {} }, 60);
      };
      for (const g of childrenOf(parentId)) {
        const subCount = childrenOf(g.id).length;
        const cmdCount = commandsOf(g.id).length;
        const isCollapsed = !!collapsed[g.id];
        rows.push(
          h("div", { key: "g" + g.id, style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer", marginLeft: depth * 18, background: "transparent" }, onClick: () => setCollapsed({ ...collapsed, [g.id]: !isCollapsed }) },
            h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, (subCount || cmdCount) ? (isCollapsed ? "▸" : "▾") : "·"),
            h("span", { style: { fontSize: 14, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.folder), g.name),
            h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, cmdCount + (subCount ? "+" + subCount + t("cmd.k187") : "")),
            h("span", { style: { marginLeft: "auto", display: "flex", gap: 2 }, onClick: (e) => e.stopPropagation() },
              h("button", { onClick: () => newCmdInGroup(g.id), style: miniBtn, title: t("cmd.k180") }, t("cmd.k411")),
              h("button", { onClick: () => { setEditing(null); setEditingGroup({ name: "", parentId: g.id }); }, style: miniBtn, title: t("cmd.k181") }, t("cmd.k412")),
              h("button", { onClick: () => setEditingGroup({ id: g.id, name: g.name, parentId: g.parentId }), style: miniBtn, title: t("cmd.k381") }, Ic(12, ICONS.pencil)),
              h("button", { onClick: async () => { if (await uiConfirm({ message: `${t("cmd.k126")}${g.name}${t("cmd.k63")}`, danger: true })) { fetch(api("/commands/groups/" + g.id), { method: "DELETE" }).then(() => refresh()); } }, style: miniBtnDanger, title: t("cmd.k125") }, Ic(12, ICONS.trash)),
            ),
          ),
        );
        if (!isCollapsed) {
          rows.push(...renderGroupTree(g.id, depth + 1));
          for (const c of commandsOf(g.id)) rows.push(renderCommandRow(c, depth + 1));
        }
      }
      return rows;
    };

    // command create/edit dialog (two-column grid form; Enter saves, textarea exempt)
    const editingDialog = editing && (() => {
      const set = (patch) => setEditing({ ...editing, ...patch });
      const ctl = (extra) => ({ ...inputStyle, flex: "none", width: "100%", boxSizing: "border-box", ...extra });
      const field = (label, control, hint, full) =>
        h("label", { style: { display: "flex", flexDirection: "column", gap: 4, gridColumn: full ? "1 / -1" : undefined, minWidth: 0 } },
          h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text-muted)" } }, label),
          control,
          hint && h("span", { style: { fontSize: 13, color: "var(--text-muted)", lineHeight: 1.4 } }, hint),
        );
      return h("div", {
        style: { position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
        onClick: () => setEditing(null),
      },
        h("div", {
          tabIndex: -1,
          "data-ext-float": "1", "data-ext-float-w": 540, "data-ext-float-autoh": "1", "data-ext-float-full": "1",
          style: { width: 540, maxWidth: "100%", maxHeight: "88vh", overflow: "auto", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", outline: "none" },
          onClick: (e) => e.stopPropagation(),
          onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); saveEditing(); } },
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" } },
            h("span", { style: { width: 28, height: 28, borderRadius: 8, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, color: "var(--accent)", flexShrink: 0 } }, "$"),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: 15, fontWeight: 700 } }, editing.id ? t("cmd.k332") : t("cmd.k267")),
              h("div", { style: { fontSize: 13, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, editing.groupId ? "📁 " + groupPathOf(editing.groupId) : t("cmd.k277")),
            ),
            h("button", { onClick: () => setEditing(null), title: t("cmd.k110"), "aria-label": t("cmd.k109"), style: { background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", padding: "4px 8px", borderRadius: 4 } }, "✕"),
          ),
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px", padding: "16px 18px" } },
            field(t("cmd.k166"), h("input", { style: ctl(), value: editing.name, placeholder: t("cmd.k334"), onChange: (e) => set({ name: e.target.value }) })),
            field(t("cmd.k116"), h("select", { style: ctl(), value: editing.groupId || "", onChange: (e) => set({ groupId: e.target.value || null }) },
              h("option", { value: "" }, t("cmd.k396")),
              groups.map((g) => h("option", { key: g.id, value: g.id }, groupPathOf(g.id))),
            )),
            field(t("cmd.k194"), h("input", { style: ctl({ fontFamily: "var(--font-mono)" }), value: editing.cwd || "", placeholder: t("cmd.k335"), onChange: (e) => set({ cwd: e.target.value }) })),
            field(t("cmd.k283"), h("input", { style: ctl(), value: editing.tags || "", placeholder: t("cmd.k377"), onChange: (e) => set({ tags: e.target.value }) })),
            field(t("cmd.k167"), h("textarea", { id: "aiti-cmd-edit-cmd", autoFocus: !editing.id, style: ctl({ minHeight: 72, fontFamily: "var(--font-mono)", resize: "vertical" }), value: editing.cmd, placeholder: "pnpm build --filter {pkg}", onChange: (e) => set({ cmd: e.target.value }) }), t("cmd.k244"), true),
            field(t("cmd.k299"), h("select", { style: ctl((editing.sandbox || "none") === "none" ? { borderColor: "var(--warn, #f59e0b)", background: "color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent)", color: "var(--warn, #f59e0b)" } : null), value: editing.sandbox || "none", onChange: (e) => set({ sandbox: e.target.value }) },
              SANDBOX_ORDER.map((v) => h("option", { key: v, value: v }, SANDBOX[v].label)),
            ), (() => { const m = SANDBOX[editing.sandbox || "none"] || SANDBOX.none; return h("span", { style: { fontSize: 13, lineHeight: 1.4, color: m.warn ? "var(--warn, #f59e0b)" : "var(--ok, #10b981)" } }, m.hint); })()),
            field(t("cmd.k230"), h("button", {
              type: "button",
              onClick: () => set({ confirm: !editing.confirm }),
              title: t("cmd.k228"),
              style: { ...ctl(), display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: "pointer", padding: "6px 10px" },
            },
              h("span", { style: { position: "relative", width: 32, height: 18, borderRadius: 999, background: editing.confirm ? "var(--warn, #f59e0b)" : "var(--border)", flexShrink: 0, transition: "background .15s" } },
                h("span", { style: { position: "absolute", top: 2, left: editing.confirm ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .15s" } }),
              ),
              h("span", { style: { fontSize: 13, color: "var(--text)" } }, editing.confirm ? t("cmd.k227") : t("cmd.k308")),
            ), null),
            field(t("cmd.k272"), h("button", {
              type: "button",
              onClick: () => set({ suggest: !editing.suggest }),
              title: t("cmd.k87"),
              style: { ...ctl(), display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: "pointer", padding: "6px 10px" },
            },
              h("span", { style: { position: "relative", width: 32, height: 18, borderRadius: 999, background: editing.suggest ? "var(--accent)" : "var(--border)", flexShrink: 0, transition: "background .15s" } },
                h("span", { style: { position: "absolute", top: 2, left: editing.suggest ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .15s" } }),
              ),
              h("span", { style: { fontSize: 13, color: "var(--text)" } }, editing.suggest ? t("cmd.k150") : t("cmd.k75")),
            ), t("cmd.k88"), true),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" } },
            h("span", { style: { ...smallStyle, flex: 1 } }, editing.id ? t("cmd.k254") : t("cmd.k91")),
            h("button", { onClick: () => setEditing(null), style: { ...btnStyle, padding: "6px 14px" } }, t("cmd.k155")),
            h("button", { onClick: saveEditing, disabled: !editing.cmd.trim(), style: { ...btnStyle, background: editing.cmd.trim() ? "var(--accent)" : "var(--bg-hover)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", padding: "6px 18px", fontWeight: 600, cursor: editing.cmd.trim() ? "pointer" : "not-allowed", opacity: editing.cmd.trim() ? 1 : 0.6 } }, editing.id ? t("cmd.k90") : t("cmd.k120")),
          ),
        ),
      );
    })();

    // group create/edit dialog
    const groupDialog = editingGroup && (() => {
      const setG = (patch) => setEditingGroup({ ...editingGroup, ...patch });
      const ctl = (extra) => ({ ...inputStyle, flex: "none", width: "100%", boxSizing: "border-box", ...extra });
      const field = (label, control) =>
        h("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
          h("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text-muted)" } }, label),
          control,
        );
      return h("div", {
        style: { position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
        onClick: () => setEditingGroup(null),
      },
        h("div", {
          tabIndex: -1,
          "data-ext-float": "1", "data-ext-float-w": 460, "data-ext-float-autoh": "1", "data-ext-float-full": "1",
          style: { width: 460, maxWidth: "100%", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", outline: "none" },
          onClick: (e) => e.stopPropagation(),
          onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setEditingGroup(null); } else if (e.key === "Enter") { e.preventDefault(); saveGroupEditing(); } },
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)" } },
            h("span", { style: { width: 28, height: 28, borderRadius: 8, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 } }, "📁"),
            h("div", { style: { flex: 1 } },
              h("div", { style: { fontSize: 15, fontWeight: 700 } }, editingGroup.id ? t("cmd.k331") : t("cmd.k266")),
              h("div", { style: { fontSize: 13, color: "var(--text-muted)" } }, editingGroup.parentId ? t("cmd.k86") + groupPathOf(editingGroup.parentId) : t("cmd.k384")),
            ),
            h("button", { onClick: () => setEditingGroup(null), title: t("cmd.k110"), "aria-label": t("cmd.k109"), style: { background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", padding: "4px 8px", borderRadius: 4 } }, "✕"),
          ),
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px", padding: "16px 18px" } },
            field(t("cmd.k117"), h("input", { autoFocus: true, style: ctl(), value: editingGroup.name, placeholder: t("cmd.k186"), onChange: (e) => setG({ name: e.target.value }) })),
            field(t("cmd.k70"), h("select", { style: ctl(), value: editingGroup.parentId || "", onChange: (e) => setG({ parentId: e.target.value || null }) },
              h("option", { value: "" }, t("cmd.k400")),
              groups.filter((g) => g.id !== editingGroup.id).map((g) => h("option", { key: g.id, value: g.id }, groupPathOf(g.id))),
            )),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" } },
            h("span", { style: { ...smallStyle, flex: 1 } }, t("cmd.k127")),
            h("button", { onClick: () => setEditingGroup(null), style: { ...btnStyle, padding: "6px 14px" } }, t("cmd.k155")),
            h("button", { onClick: saveGroupEditing, disabled: !editingGroup.name.trim(), style: { ...btnStyle, background: editingGroup.name.trim() ? "var(--accent)" : "var(--bg-hover)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", padding: "6px 18px", fontWeight: 600, cursor: editingGroup.name.trim() ? "pointer" : "not-allowed", opacity: editingGroup.name.trim() ? 1 : 0.6 } }, editingGroup.id ? t("cmd.k90") : t("cmd.k120")),
          ),
        ),
      );
    })();

    return h(CmdWindow, { app: "favorites", subtitle: commands.length + t("cmd.k19") },
      // toolbar: search + new command + new group + dictionary
      h("div", { style: { ...rowStyle, flexShrink: 0 } },
        h("input", { style: { ...inputStyle, maxWidth: 240 }, value: q, placeholder: t("cmd.k243"), onChange: (e) => setQ(e.target.value) }),
        h("button", { onClick: () => { setEditingGroup(null); setEditing({ name: "", cmd: "", cwd: "", tags: "", confirm: false, groupId: null, sandbox: "none", suggest: true }); }, style: btnStyle, title: t("cmd.k407") }, t("cmd.k406")),
        h("button", { onClick: () => { setEditing(null); setEditingGroup({ name: "", parentId: null }); }, style: btnStyle, title: t("cmd.k405") }, t("cmd.k403")),
        h("button", { onClick: async () => { await loadDict(); setDictOpen(!dictOpen); }, style: btnStyle, title: t("cmd.k356") }, t("cmd.k355")),
      ),
      // tag filter chips
      allTags.length > 0 && h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 2, flexShrink: 0 } },
        h("button", { onClick: () => setActiveTag(null), title: t("cmd.k107"), style: { ...btnStyle, padding: "1px 8px", fontSize: 13, background: !activeTag ? "var(--accent)" : "transparent", color: !activeTag ? "#fff" : "var(--text)", border: "1px solid " + (!activeTag ? "var(--accent)" : "var(--border)") } }, t("cmd.k105")),
        allTags.map((tag) =>
          h("button", { key: tag, onClick: () => setActiveTag(activeTag === tag ? null : tag), title: "#" + tag + t("cmd.k414"), style: { ...btnStyle, padding: "1px 8px", fontSize: 13, background: activeTag === tag ? "var(--accent)" : "transparent", color: activeTag === tag ? "#fff" : "var(--text)", border: "1px solid " + (activeTag === tag ? "var(--accent)" : "var(--border)") } }, "#" + tag)),
      ),
      // recognition dictionary (user-extensible word list)
      dictOpen && h("div", { style: { border: "1px solid var(--border)", borderRadius: 8, padding: 8, marginBottom: 4, background: "var(--bg)", flexShrink: 0 } },
        h("div", { style: { ...rowStyle, marginBottom: 4 } },
          h("b", { style: { fontSize: 14 } }, t("cmd.k209")),
          h("span", { style: { ...smallStyle, flex: 1 } }, t("cmd.k114") + (dictData ? dictData.groups.reduce((a, g) => a + g.names.length, 0) : "?") + t("cmd.k14")),
          h("button", { onClick: () => setDictOpen(false), title: t("cmd.k112"), style: { ...btnStyle, padding: "2px 8px", display: "inline-flex" } }, Ic(12, ICONS.x)),
        ),
        dictData && h("div", { style: { display: "flex", flexWrap: "wrap", gap: "2px 8px", marginBottom: 6, fontSize: 13, color: "var(--text-muted)" } },
          dictData.groups.map((g) => h("span", { key: g.group, style: { padding: "1px 8px", background: "var(--bg-hover)", borderRadius: 6 } }, g.group + ": " + g.names.slice(0, 12).join(" ") + (g.names.length > 12 ? " …" : ""))),
        ),
        h("textarea", { style: { ...inputStyle, minHeight: 56, fontFamily: "var(--font-mono)" }, value: dictText, placeholder: t("cmd.k343"), onChange: (e) => setDictText(e.target.value) }),
        h("div", { style: { ...rowStyle, marginTop: 4 } },
          h("button", { onClick: async () => { await fetch(api("/commands/dict"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ extra: dictText.split(/\n|,|，/).map((s) => s.trim()).filter(Boolean) }) }); setDictText(""); refresh(); loadDict(); }, style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none" }, title: t("cmd.k93") }, t("cmd.k94")),
          h("span", { style: smallStyle }, t("cmd.k260")),
        ),
      ),
      err && h("p", { style: { ...smallStyle, color: "var(--danger, #ef4444)", marginBottom: 6 } }, String(err)),
      // command tree
      h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 } },
        filtered.length === 0 && groups.length === 0 ? h("p", { style: smallStyle }, t("cmd.k391"))
        : [
            renderGroupTree(null, 0),
            ungrouped.length > 0 && h("div", { key: "_ungrouped", style: { marginTop: 4 } },
              h("div", { style: { fontSize: 13, color: "var(--text-muted)", padding: "2px 8px" } }, t("cmd.k277")),
              ungrouped.map((c) => renderCommandRow(c, 0)),
            ),
          ],
      ),
      editingDialog, groupDialog,
    );
  };
}

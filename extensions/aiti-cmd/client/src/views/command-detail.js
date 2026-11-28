/**
 * aiti-cmd client · command detail card (aiti-cmd-detail)
 *
 * Opened by message recognition (aiti-msg-smart popover / inline code) and by the share
 * sink. Behaviour is unchanged from the old single-file client: edit name/group/cwd,
 * save as a favorite, or run it. Cross-app: save → favorites app, run → terminal app.
 */
import { btnStyle, rowStyle, inputStyle, smallStyle } from "../kit.js";
import { uiConfirm } from "@aiti-ai/ext-shared/ui-dialogs";

export function createCommandDetail(kit, store, deps) {
  const { h, t, api, useState, useEffect } = kit;
  const { useStore } = deps;

  return function CommandDetailPanel() {
    const st = useStore();
    const detail = st.detail;
    const busy = st.detailBusy;
    const [name, setName] = useState("");
    const [cwd, setCwd] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [groupId, setGroupId] = useState(null);
    const [groups, setGroups] = useState([]);
    const [saved, setSaved] = useState(false);
    const [err, setErr] = useState(null);
    const [info, setInfo] = useState(null);
    const [desc, setDesc] = useState(null);
    const [current, setCurrent] = useState(null); // command currently shown/managed (related chips switch it)
    useEffect(() => {
      if (detail) {
        setName(""); setCwd(detail.cwd || ""); setConfirm(false); setGroupId(null);
        setSaved(false); setErr(null); setInfo(null); setDesc(null); setCurrent(detail.cmd);
        fetch(api("/commands")).then((r) => r.json()).then((d) => setGroups(d.groups || [])).catch(() => {});
      }
    }, [detail]);
    // validation + description follow the current command (related/peers switch it)
    useEffect(() => {
      if (!current) return;
      fetch(api("/commands/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: current }) }).then((r) => r.json()).then((d) => { const c = d.single || (Array.isArray(d.commands) && d.commands[0]) || null; setInfo(c || null); }).catch(() => {});
      fetch(api("/commands/describe?text=" + encodeURIComponent(current))).then((r) => r.json()).then((d) => setDesc(d || null)).catch(() => {});
    }, [current, detail]);
    if (!detail) return null;

    const groupPathOf = (id) => {
      if (!id) return t("cmd.k277");
      const parts = []; let cur = groups.find((g) => g.id === id); let guard = 0;
      while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? groups.find((g) => g.id === cur.parentId) : undefined; }
      return parts.join(" / ") || t("cmd.k277");
    };
    const doSave = async () => {
      setSaved(false); setErr(null);
      if (!current || !String(current).trim()) { setErr(t("cmd.k171")); return; }
      const r = await fetch(api("/commands"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name || current, cmd: current, cwd: cwd || undefined, groupId: groupId || null, confirm, sandbox: "none", source: "ai-message" }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k92") }));
      if (r.ok) {
        setSaved(true);
        // cross-app: reveal the saved command in the favorites window
        const id = r.command && r.command.id;
        store.openApp("favorites", id ? { focus: id } : {});
      } else setErr(r.error || t("cmd.k92"));
    };
    const doRun = async () => {
      const cmd = current;
      let r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd, cwd: cwd || undefined, source: "message", sandbox: "none" }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
      if (r.needConfirm) {
        const danger = (r.danger || []).join("/");
        const ok = await uiConfirm({ message: `${t("cmd.k311")}${danger ? "（" + danger + "）" : ""}？`, detail: `$ ${cmd}`, danger: true });
        if (!ok) return;
        r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd, cwd: cwd || undefined, source: "message", sandbox: "none", confirmToken: r.confirmToken }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
      }
      if (!r.ok) { setErr(r.error || t("cmd.k366")); return; }
      store.set({ detail: null });
      store.openApp("terminal", { sessionId: r.sessionId, title: cmd });
    };
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 330, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
      onClick: () => store.set({ detail: null }),
    },
      h("div", {
        "data-ext-float": "1", "data-ext-float-w": 460, "data-ext-float-h": 540, "data-ext-float-full": "1",
        style: { width: 460, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", overflow: "hidden" },
        onClick: (e) => e.stopPropagation(),
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 } },
          h("span", { style: { width: 28, height: 28, borderRadius: 8, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 } }, "＋"),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 15, fontWeight: 700 } }, t("cmd.k175")),
            h("div", { style: { fontSize: 13, color: "var(--text-muted)" } }, t("cmd.k282")),
          ),
          h("button", { onClick: () => store.set({ detail: null }), title: t("cmd.k109"), "aria-label": t("cmd.k109"), style: { ...btnStyle, padding: "2px 10px", background: "transparent", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)" } }, "✕"),
        ),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: 14 } },
          h("p", { style: { ...smallStyle, marginBottom: 8, color: "var(--text-muted)" } }, t("cmd.k298")),
          current !== detail.cmd && h("div", { style: { ...rowStyle, marginBottom: 4 } },
            h("button", { onClick: () => setCurrent(detail.cmd), title: t("cmd.k369"), style: { ...btnStyle, padding: "1px 8px", fontSize: 13 } }, t("cmd.k52") + detail.cmd.slice(0, 30)),
            h("span", { style: smallStyle }, t("cmd.k296")),
          ),
          h("pre", { style: { background: "#0f172a", color: "#a5f3fc", padding: 10, borderRadius: 8, fontSize: 13, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0 0 8px" } }, current),
          info && h("div", { style: { ...smallStyle, marginBottom: 8 } },
            info.exists === false
              ? h("span", { style: { color: "var(--danger, #ef4444)" } }, "command not found：" + info.cmd + t("cmd.k18"))
              : h("span", {}, t("cmd.k172") + (info.exists === true ? t("cmd.k3") : "")),
            (info.params && info.params.length) ? h("span", {}, t("cmd.k2") + info.params.join("}, {") + "}") : null,
            (info.danger && info.danger.length) ? h("span", {}, t("cmd.k1") + info.danger.join("/")) : null,
          ),
          info && info.exists === false && info.installSuggestion && h("div", { style: { ...smallStyle, marginBottom: 8, background: "color-mix(in srgb, var(--danger, #ef4444) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 35%, transparent)", borderRadius: 6, padding: "6px 8px", color: "var(--danger, #ef4444)" } },
            h("span", { style: { fontWeight: 600 } }, t("cmd.k188")), h("code", { style: { fontSize: 13 } }, info.installSuggestion),
            h("button", { onClick: () => { try { navigator.clipboard.writeText(info.installSuggestion); } catch {} }, style: { ...btnStyle, padding: "1px 8px", fontSize: 13, marginLeft: 6 } }, t("cmd.k182")),
          ),
          desc && desc.found && h("div", { style: { ...smallStyle, marginBottom: 8, background: "var(--bg-hover)", borderRadius: 6, padding: "6px 8px" } },
            h("span", { style: { fontWeight: 600 } }, "📂 " + desc.name + " · " + desc.group + ""),
            desc.desc ? h("span", { style: { marginLeft: 6 } }, desc.desc) : null,
            desc.related && desc.related.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 } },
              h("span", { style: { fontSize: 13, color: "var(--text-muted)", marginRight: 2 } }, t("cmd.k207")),
              desc.related.map((p) => h("button", { key: p, type: "button", onClick: () => setCurrent(p), title: t("cmd.k305"), style: { fontSize: 13, background: "var(--bg)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--border)", color: "var(--accent)", cursor: "pointer" } }, p)))
            : null,
            desc.peers && desc.peers.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 } },
              h("span", { style: { fontSize: 13, color: "var(--text-muted)", marginRight: 2 } }, t("cmd.k165")),
              desc.peers.map((p) => h("button", { key: p, type: "button", onClick: () => setCurrent(p), title: t("cmd.k305"), style: { fontSize: 13, background: "var(--bg)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--border)", color: "var(--accent)", cursor: "pointer" } }, p)))
            : null,
          ),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 } },
            h("input", { style: inputStyle, value: name, placeholder: t("cmd.k247"), onChange: (e) => setName(e.target.value) }),
            h("select", { style: inputStyle, value: groupId || "", title: t("cmd.k246"), onChange: (e) => setGroupId(e.target.value || null) },
              h("option", { value: "" }, t("cmd.k396")),
              groups.map((g) => h("option", { key: g.id, value: g.id }, groupPathOf(g.id))),
            ),
            h("input", { style: inputStyle, value: cwd, placeholder: t("cmd.k42"), onChange: (e) => setCwd(e.target.value) }),
            h("label", { style: { fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 } }, h("input", { type: "checkbox", checked: confirm, onChange: (e) => setConfirm(e.target.checked) }), t("cmd.k146")),
          ),
          err && h("p", { style: { ...smallStyle, color: "var(--danger, #ef4444)", marginBottom: 6 } }, String(err)),
          h("div", { style: { display: "flex", gap: 8 } },
            h("button", { onClick: doSave, style: { ...btnStyle, background: "var(--accent)", color: "#fff", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "none", flex: 1 } }, saved ? t("cmd.k201") : t("cmd.k402")),
            h("button", { onClick: doRun, style: { ...btnStyle, flex: 1, color: "var(--accent)" } }, busy ? "…" : t("cmd.k58")),
          ),
          h("p", { style: { ...smallStyle, marginTop: 8 } }, t("cmd.k248")),
        ),
      ),
    );
  };
}

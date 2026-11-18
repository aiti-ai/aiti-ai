/**
 * aiti-cmd client · 终端 app (aiti-cmd-terminal)
 *
 * Real PTY interaction only: xterm view + session tab strip + new terminal + kill +
 * "move to workspace tab" + "★ save this command". Opening a session from another app
 * (favorites ▶ / running row / message detail) lands here via store.openApp("terminal").
 */
import { btnStyle, smallStyle } from "../kit.js";

export function createTerminalApp(kit, store, deps) {
  const { h, t, api, Ic, ICONS, useState, useEffect } = kit;
  const { CmdWindow, TerminalView, tabs, useStore } = deps;

  return function TerminalApp() {
    const st = useStore();
    const open = !!st.open.terminal;
    const sid = st.terminal.sessionId;
    const [sessions, setSessions] = useState([]);
    const [piCounts, setPiCounts] = useState({ piRunning: 0, piTotal: 0 });
    const [killBusy, setKillBusy] = useState(() => new Set());
    const [newBusy, setNewBusy] = useState(false);
    const [err, setErr] = useState(null);
    // the dialog must not render a session that a workspace tab currently owns (single instance)
    const hostTabId = tabs.useSessionHostTab(sid);
    const [, tick] = useState(0);

    // session list for the tab strip (event-driven; one initial pull)
    const refresh = () => {
      fetch(api("/sessions")).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => {});
      fetch(api("/pi-commands")).then((r) => r.json()).then((d) => {
        const list = d.commands || [];
        setPiCounts({ piRunning: list.filter((c) => c.status === "running").length, piTotal: list.length });
      }).catch(() => {});
    };
    useEffect(() => {
      if (!open) return;
      refresh();
      const sub = kit.ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
      if (!sub) return;
      const s = sub((f) => {
        if (f.evt === "sessions") setSessions(f.sessions || []);
      }, ["cmd-sessions"]);
      kit.aliveAdd("cmd-sessions");
      s.ready.then(refresh).catch(() => {});
      return () => { try { s.off(); } catch {} kit.aliveDel("cmd-sessions"); };
    }, [open]);
    // runtime seconds tick (local re-render only, no network)
    useEffect(() => {
      if (!open) return;
      const iv = setInterval(() => tick((n) => n + 1), 1000);
      return () => clearInterval(iv);
    }, [open]);
    // reset the transient error when switching sessions
    useEffect(() => { setErr(null); }, [sid]);

    if (!open) return null;

    const cur = sid ? sessions.find((s) => s.id === sid) || null : null;
    const counts = { ...piCounts, ptyRunning: sessions.filter((s) => s.status === "running").length, ptyQueued: sessions.filter((s) => s.status === "queued").length };
    const live = sessions.filter((s) => s.status === "running" || s.status === "queued");
    // tab strip: live sessions + the current one (a dead session keeps rendering its tail)
    const strip = live.slice();
    if (sid && !strip.some((s) => s.id === sid)) {
      const dead = sessions.find((s) => s.id === sid);
      strip.push(dead || { id: sid, name: st.terminal.title || sid, cmd: st.terminal.title || "", status: "dead" });
    }

    const openSession = (s) => store.openApp("terminal", { sessionId: s.id, title: s.name || s.cmd });
    const killSession = (id) => {
      if (killBusy.has(id)) return;
      setKillBusy((prev) => new Set(prev).add(id));
      fetch(api(`/sessions/${id}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        // keep the busy state visible until the server's SIGKILL fallback window passes
        setTimeout(() => setKillBusy((prev) => { const n = new Set(prev); n.delete(id); return n; }), 3500);
      });
    };
    // new shell at the current terminal's live cwd (falls back to the host's selected cwd)
    const newShell = async () => {
      if (newBusy) return;
      setNewBusy(true);
      setErr(null);
      try {
        const cwd = sid ? await kit.liveCwdOf(sid, cur?.cwd) : (kit.ctx?.getExtService?.("pi-web.ui")?.get?.("selectedCwd") || undefined);
        const r = await fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, name: t("cmd.k325"), ttlMs: 24 * 3600 * 1000 }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
        if (!r || !r.ok) { setErr((r && r.error) || t("cmd.k122")); return; }
        store.openApp("terminal", { sessionId: r.sessionId, title: r.name || t("cmd.k325") });
        refresh();
      } finally { setNewBusy(false); }
    };
    const newPiSession = async () => {
      const live2 = sid ? await kit.liveCwdOf(sid, cur?.cwd) : undefined;
      if (!kit.openNewPiSession(live2)) setErr(live2 ? t("cmd.k262") : t("cmd.k263"));
    };
    // ★ save the running command as a favorite → favorites app, new-command form prefilled
    const saveFavorite = (meta) => {
      if (!meta || !meta.cmd) return;
      store.openApp("favorites", { create: { cmd: String(meta.cmd), cwd: meta.cwd || "" } });
    };
    // ⇱ move to the workspace tab (ownership hand-over; the dialog shows a placeholder afterwards)
    const moveToTab = () => {
      const r = tabs.sendToTab(cur || { id: sid, cwd: cur?.cwd, name: st.terminal.title });
      if (!r.ok) setErr(r.error || "");
      else store.closeApp("terminal");
    };
    const takeBack = () => { if (sid) tabs.detachToDialog(sid); };
    // ↻ reopen the same command after it exited
    const reopen = async () => {
      const cmd = cur?.cmd;
      if (!cmd) return;
      const r = await fetch(api("/run"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd, cwd: cur?.cwd, name: cur?.name, source: "shell", sandbox: "none", confirmToken: null }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
      if (!r || !r.ok) { setErr((r && r.error) || t("cmd.k366")); return; }
      store.openApp("terminal", { sessionId: r.sessionId, title: cur?.name || cmd });
      refresh();
    };

    const tabBtn = (active) => ({
      ...btnStyle, padding: "1px 8px", fontSize: 12, height: 22,
      background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
      border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
      color: active ? "var(--accent)" : "var(--text-muted)", fontWeight: active ? 700 : 400,
      maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-flex",
    });

    let body;
    if (!sid) {
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--text-dim)", fontSize: 12 } },
        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, t("cmd.app.terminal.empty")),
        h("button", { onClick: newShell, disabled: newBusy, style: { ...btnStyle, background: "var(--accent)", color: "#fff", border: "none", padding: "6px 16px", fontWeight: 600 } }, newBusy ? "…" : t("cmd.k404")),
        err && h("span", { role: "alert", style: { color: "var(--danger, #ef4444)" } }, err),
      );
    } else if (hostTabId) {
      // owned by a workspace tab (single instance): offer to pull it back into the window
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" } },
          h("span", { style: { display: "inline-flex" } }, Ic(14, ICONS.monitor)),
          h("span", null, t("cmd.k297")),
        ),
        h("button", { onClick: takeBack, style: { ...btnStyle, padding: "6px 14px", color: "var(--accent)", fontWeight: 600, fontSize: 12 } }, t("cmd.k231")),
        h("span", { style: { fontSize: 11, color: "var(--text-muted)" } }, t("cmd.k329")),
      );
    } else {
      body = h(TerminalView, {
        sessionId: sid,
        height: "100%",
        counts,
        onExit: refresh,
        killPending: killBusy.has(sid),
        sendToTab: cur && (cur.status === "running" || cur.status === "queued") ? moveToTab : undefined,
        onNewShell: newShell,
        onNewPiSession: newPiSession,
        onSaveFavorite: saveFavorite,
        onReopen: cur && cur.status === "dead" ? reopen : undefined,
      });
    }

    return h(CmdWindow, { app: "terminal", subtitle: cur ? (cur.name || cur.cmd) : t("cmd.app.terminal.title") },
      // session tab strip (only when there is something to switch between)
      strip.length > 0 && h("div", { style: { display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", flexShrink: 0 } },
        strip.map((s) => {
          const active = s.id === sid;
          const hosted = !!tabs.sessionHostTabSync(s.id);
          return h("button", {
            key: s.id,
            onClick: () => (active ? null : openSession(s)),
            title: (s.cmd || s.name || s.id) + (hosted ? t("cmd.k193") : ""),
            style: tabBtn(active),
          }, (s.status === "running" ? "● " : s.status === "queued" ? "⏳ " : "■ ") + (s.name || s.cmd || s.id) + (hosted ? " ⇱" : ""));
        }),
        h("button", { onClick: newShell, disabled: newBusy, title: t("cmd.k410"), style: { ...btnStyle, padding: "1px 8px", fontSize: 12, height: 22 } }, "+"),
        err && h("span", { style: { ...smallStyle, color: "var(--danger, #ef4444)", fontSize: 12 } }, err),
      ),
      h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } }, body),
    );
  };
}

/**
 * aiti-cmd client · 运行中 app (aiti-cmd-running)
 *
 * Runtime situation only: PTY sessions + agent bash commands + the audit log.
 * Top filter (same shape as "All sessions"): ● running (default) / all (incl. exited) / records.
 * Clicking a PTY row opens the terminal app; clicking an agent row opens the in-app live
 * output sub-view (agent bash has no stdin, so it is not a terminal).
 */
import { btnStyle, smallStyle } from "../kit.js";

export function createRunningApp(kit, store, deps) {
  const { h, t, api, Ic, ICONS, useState, useEffect } = kit;
  const { CmdWindow, PiCommandView, tabs, useStore, SOURCE_LABEL } = deps;

  return function RunningApp() {
    const st = useStore();
    const open = !!st.open.running;
    const filter = st.running.filter || "live";
    const piView = st.running.piView;
    const [sessions, setSessions] = useState([]);
    const [piCmds, setPiCmds] = useState([]);
    const [records, setRecords] = useState([]);
    const [srcGroups, setSrcGroups] = useState([]);
    const [srcFilter, setSrcFilter] = useState(null);
    const [expanded, setExpanded] = useState(null);
    const [outputs, setOutputs] = useState({});
    const [killBusy, setKillBusy] = useState(() => new Set());
    const [piKillBusy, setPiKillBusy] = useState(() => new Set());
    const [newBusy, setNewBusy] = useState(false);
    const [verifyResult, setVerifyResult] = useState(null);
    const [err, setErr] = useState(null);
    const [, tick] = useState(0);

    const refresh = () => {
      fetch(api("/sessions")).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch(() => {});
      fetch(api("/pi-commands")).then((r) => r.json()).then((d) => setPiCmds(d.commands || [])).catch(() => {});
    };
    const refreshHistory = () => {
      fetch(api("/history?limit=200")).then((r) => r.json()).then((d) => setRecords(d.records || [])).catch(() => {});
      fetch(api("/history?groupBy=source")).then((r) => r.json()).then((d) => setSrcGroups(d.groups || [])).catch(() => {});
    };
    // one initial pull for whatever segment is visible
    useEffect(() => {
      if (!open) return;
      if (filter === "history") refreshHistory(); else refresh();
    }, [open, filter]);
    // live frames: sessions + agent command list (event bus only, no polling)
    useEffect(() => {
      if (!open || filter === "history" || piView) return;
      const sub = kit.ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
      if (!sub) return;
      const s = sub((f) => {
        if (f.evt === "sessions") setSessions(f.sessions || []);
        else if (f.evt === "pilist") setPiCmds(f.commands || []);
      }, ["cmd-sessions", "cmd-pilist"]);
      kit.aliveAdd("cmd-sessions", "cmd-pilist");
      s.ready.then(refresh).catch(() => {});
      return () => { try { s.off(); } catch {} kit.aliveDel("cmd-sessions", "cmd-pilist"); };
    }, [open, filter, piView]);
    // runtime seconds tick (local re-render only)
    useEffect(() => {
      if (!open) return;
      const iv = setInterval(() => tick((n) => n + 1), 1000);
      return () => clearInterval(iv);
    }, [open]);
    useEffect(() => { setErr(null); }, [filter]);

    if (!open) return null;

    const killSession = (id) => {
      if (killBusy.has(id)) return;
      setKillBusy((prev) => new Set(prev).add(id));
      fetch(api(`/sessions/${id}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        setTimeout(() => setKillBusy((prev) => { const n = new Set(prev); n.delete(id); return n; }), 3500);
      });
    };
    const killPiCommand = (id) => {
      if (piKillBusy.has(id)) return;
      setPiKillBusy((prev) => new Set(prev).add(id));
      fetch(api(`/pi-commands/${id}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        setTimeout(() => setPiKillBusy((prev) => { const n = new Set(prev); n.delete(id); return n; }), 1500);
      });
    };
    const newShell = async () => {
      if (newBusy) return;
      setNewBusy(true);
      setErr(null);
      try {
        const cwd = kit.ctx?.getExtService?.("pi-web.ui")?.get?.("selectedCwd") || undefined;
        const r = await fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, name: t("cmd.k325"), ttlMs: 24 * 3600 * 1000 }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
        if (!r || !r.ok) { setErr((r && r.error) || t("cmd.k122")); return; }
        store.openApp("terminal", { sessionId: r.sessionId, title: r.name || t("cmd.k325") });
        refresh();
      } finally { setNewBusy(false); }
    };
    const expand = async (id) => {
      if (expanded === id) { setExpanded(null); return; }
      setExpanded(id);
      if (outputs[id] === undefined) {
        const d = await fetch(api("/history/" + id)).then((r) => r.json()).catch(() => null);
        setOutputs((o) => ({ ...o, [id]: (d && d.output) || t("cmd.k393") }));
      }
    };
    const verifyChain = async () => {
      const d = await fetch(api("/history/verify")).then((r) => r.json()).catch(() => null);
      if (!d) { setVerifyResult(t("cmd.k284")); return; }
      setVerifyResult(d.ok ? t("cmd.k383") + d.checkedHashes + t("cmd.k21") + (d.legacy ? "（legacy " + d.legacy + "）" : "") : t("cmd.k316") + (d.brokenAt || "?") + " · " + d.checkedHashes + t("cmd.k19"));
    };

    const livePi = piCmds.filter((c) => c.status === "running");
    const livePty = sessions.filter((s) => s.status === "running" || s.status === "queued");
    const runningCount = livePi.length + livePty.length;
    const chip = (id, label, active) => h("button", {
      key: id,
      onClick: () => { store.setIn("running", { filter: id, piView: null }); setSrcFilter(null); },
      style: { ...btnStyle, padding: "2px 10px", height: 22, fontSize: 12, background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent", border: "1px solid " + (active ? "var(--accent)" : "var(--border)"), color: active ? "var(--accent)" : "var(--text-muted)", fontWeight: active ? 700 : 400 },
    }, label);

    const header = h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 0 } },
      piView
        ? h("button", { onClick: () => store.setIn("running", { piView: null }), style: { ...btnStyle, padding: "2px 10px", height: 22, fontSize: 12 } }, t("cmd.k53"))
        : [
            chip("live", "● " + t("cmd.k22") + " (" + runningCount + ")", filter === "live"),
            chip("all", t("cmd.app.running.all"), filter === "all"),
            chip("history", t("cmd.k148"), filter === "history"),
          ],
      h("div", { style: { flex: 1 } }),
      filter === "history" && h("button", { onClick: verifyChain, title: t("cmd.k285"), style: { ...btnStyle, padding: "2px 10px", height: 22, fontSize: 12 } }, verifyResult ? "✓ " + verifyResult : [Ic(12, ICONS.lock), t("cmd.k286")]),
      h("button", { onClick: () => (filter === "history" ? refreshHistory() : refresh()), title: t("cmd.k132"), style: { ...btnStyle, padding: "2px 8px", height: 22 } }, "↻"),
      filter !== "history" && h("button", { onClick: newShell, disabled: newBusy, title: t("cmd.k410"), style: { ...btnStyle, padding: "2px 8px", height: 22 } }, newBusy ? "…" : "＋"),
      err && h("span", { style: { ...smallStyle, color: "var(--danger, #ef4444)", fontSize: 12 } }, err),
    );

    // agent command row (🤖): click → in-app live output sub-view
    const piRow = (c) => h("div", {
      key: c.id,
      style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" },
      onClick: () => store.setIn("running", { piView: { id: c.id, title: c.cmd } }),
    },
      h("span", { style: { fontSize: 13, color: c.status === "running" ? "var(--ok, #4ade80)" : c.isError ? "var(--danger, #f87171)" : "var(--text-muted)" } }, c.status === "running" ? "●" : c.isError ? "⚠" : "■"),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("code", { style: { fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + (c.cmd || t("cmd.k399"))),
        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } },
          "🤖 " + String(c.sessionId || "").slice(0, 8) + (c.cwd ? " · " + c.cwd : "") + " · " + (c.status === "running" ? t("cmd.k365") : c.isError ? t("cmd.k115") : t("cmd.k189")) + " · " + ((c.status === "running" ? Date.now() - c.startedTs : c.durationMs || 0) / 1000).toFixed(0) + "s" + (c.bytes ? " · " + (c.bytes / 1024).toFixed(1) + "KB" : "") + (c.truncated ? t("cmd.k5") : "")),
      ),
      c.status === "running" && h("button", { onClick: (e) => { e.stopPropagation(); killPiCommand(c.id); }, disabled: piKillBusy.has(c.id), title: piKillBusy.has(c.id) ? t("cmd.k322") : t("cmd.k159"), style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: "2px 8px", opacity: piKillBusy.has(c.id) ? 0.6 : 1, cursor: piKillBusy.has(c.id) ? "wait" : "pointer" } }, piKillBusy.has(c.id) ? "⏳" : "⏹"),
    );

    // PTY session row (🖥): click → terminal app
    const ptyRow = (s) => h("div", {
      key: s.id,
      style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" },
      onClick: () => store.openApp("terminal", { sessionId: s.id, title: s.name || s.cmd }),
    },
      h("span", { style: { fontSize: 13, color: s.status === "running" ? "var(--ok, #4ade80)" : s.status === "queued" ? "var(--warn, #f59e0b)" : "var(--text-muted)" } }, s.status === "running" ? "●" : s.status === "queued" ? "⏳" : "■"),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("code", { style: { fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + s.cmd + (kit.SANDBOX[s.sandbox || "none"] ? kit.SANDBOX[s.sandbox || "none"].icon : "")),
        h("span", { style: { fontSize: 13, color: "var(--text-muted)" } },
          (tabs.sessionHostTabSync(s.id) ? t("cmd.k193") : "") +
          (s.status === "queued" ? t("cmd.k238") + s.queuePosition + "/" + s.queueLength + ")" : (s.status === "running" ? t("cmd.k365") : t("cmd.k372") + (s.exitCode ?? "?")) + " · " + ((s.status === "running" ? Date.now() - s.startTs : s.durationMs || 0) / 1000).toFixed(0) + "s" + (s.sandbox ? " · " + (kit.SANDBOX[s.sandbox] ? kit.SANDBOX[s.sandbox].short : s.sandbox) : t("cmd.k6")))),
      ),
      (s.status === "running" || s.status === "queued") && h("button", { onClick: (e) => { e.stopPropagation(); killSession(s.id); }, disabled: killBusy.has(s.id), title: killBusy.has(s.id) ? t("cmd.k322") : s.status === "queued" ? t("cmd.k157") : t("cmd.k324"), style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: "2px 8px", opacity: killBusy.has(s.id) ? 0.6 : 1, cursor: killBusy.has(s.id) ? "wait" : "pointer" } }, killBusy.has(s.id) ? "⏳" : s.status === "queued" ? t("cmd.k155") : "⏹"),
    );

    let content;
    if (piView) {
      content = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
        h(PiCommandView, {
          cmdId: piView.id,
          counts: { piRunning: livePi.length, piTotal: piCmds.length, ptyRunning: livePty.length, ptyQueued: 0 },
          onSaveCommand: (p) => store.set({ detail: { cmd: p.cmd, cwd: p.cwd || null }, detailBusy: false }),
        }),
      );
    } else if (filter === "history") {
      content = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 } },
        // source distribution chips (audit "who ran it" view; click filters, click again clears)
        srcGroups.length > 0 && h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", flexShrink: 0 } },
          h("span", { style: { ...smallStyle, marginRight: 2 } }, t("cmd.k281")),
          srcGroups.map((g) => h("button", {
            key: g.source,
            onClick: () => setSrcFilter(srcFilter === g.source ? null : g.source),
            title: SOURCE_LABEL[g.source] || g.source + t("cmd.k413") + g.count + t("cmd.k23") + g.failCount + "（" + Math.round(g.failRate * 100) + t("cmd.k27") + new Date(g.lastTs).toLocaleString("zh-CN", { hour12: false }),
            style: { ...btnStyle, padding: "1px 8px", fontSize: 13, background: srcFilter === g.source ? "var(--accent)" : "transparent", color: srcFilter === g.source ? "#fff" : "var(--text)", border: "1px solid " + (srcFilter === g.source ? "var(--accent)" : "var(--border)") },
          }, (SOURCE_LABEL[g.source] || g.source) + " " + g.count + (g.failCount ? " ⚠" + g.failCount : ""))),
        ),
        h("div", { style: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 } },
          records.length === 0 ? h("p", { style: smallStyle }, t("cmd.k394"))
          : (srcFilter ? records.filter((r) => r.source === srcFilter) : records).map((rec) =>
            h("div", { key: rec.id, style: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px", borderRadius: 8, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" }, onClick: () => expand(rec.id) },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                h("span", { style: { fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap" } }, new Date(rec.ts).toLocaleString("zh-CN", { hour12: false })),
                h("code", { style: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "$ " + rec.cmd),
                h("span", { style: { fontSize: 13, color: rec.exit === 0 ? "var(--ok, #4ade80)" : "var(--danger, #f87171)" } }, "exit " + (rec.exit ?? "?")),
                h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, ((rec.durationMs || 0) / 1000).toFixed(1) + "s"),
                h("span", { style: { fontSize: 13, color: "var(--text-muted)" } }, SOURCE_LABEL[rec.source] || rec.source),
                rec.danger && rec.danger.length ? h("span", { style: { color: "var(--warn, #f59e0b)", display: "inline-flex" } }, Ic(12, ICONS.alert)) : null,
              ),
              expanded === rec.id && h("pre", { style: { ...smallStyle, background: "#0f172a", color: "#a5f3fc", padding: 8, borderRadius: 6, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--font-mono)" } }, outputs[rec.id] !== undefined ? outputs[rec.id] : t("cmd.k145")),
            )),
        ),
      );
    } else {
      // live (default) / all: agent commands + terminals
      const piList = filter === "all" ? piCmds : livePi;
      const ptyList = filter === "all" ? sessions : livePty;
      content = h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { fontSize: 14, fontWeight: 700, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.bot), t("cmd.k40")),
          piList.length === 0 ? h("p", { style: { ...smallStyle, margin: 0 } }, t("cmd.k397"))
          : piList.map(piRow),
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { fontSize: 14, fontWeight: 700, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.monitor), t("cmd.k326")),
          ptyList.length === 0 ? h("p", { style: { ...smallStyle, margin: 0 } }, t("cmd.k392"))
          : ptyList.map(ptyRow),
        ),
      );
    }

    return h(CmdWindow, { app: "running", subtitle: t("cmd.app.running.subtitle") }, header, content);
  };
}

/**
 * aiti-cmd client · workspace terminal tab (terminalDock slot) + the single-instance
 * ownership state machine shared with the terminal dialog app.
 *
 * A PTY session may render in exactly one place at a time: the workspace tab (right file
 * dock) or the terminal window. tabAttached[tabId] = the bound session, tabDetached[tabId]
 * = "the view was pulled back into the window". Both sides show a placeholder for the
 * other, which structurally prevents double rendering (double input / double frame
 * consumption).
 */
import { btnStyle, readTermTheme, subscribeTermTheme } from "../kit.js";

export function createTabs(kit, store, deps) {
  const { h, t, api, Ic, ICONS, useState, useEffect, useRef, liveCwdOf, openNewPiSession } = kit;
  const { TerminalView } = deps;

  const mountCounts = new Map(); // tabId → live component instances (host remount tolerance)
  const tabAttached = {};   // { [tabId]: { sessionId, title, cwd } | undefined }
  const tabDetached = {};   // { [tabId]: true } — true = the view lives in the dialog
  const tabAttachedListeners = new Set();
  function notifyTabAttached() { for (const l of tabAttachedListeners) l(); }

  // tabId→sessionId binding persisted in sessionStorage (same lifetime as the host's
  // pi-web:terminal-tabs): after a refresh the host restores tabs by id, the binding is
  // found again and TerminalView replays the buffered output instead of spawning a new shell.
  const DOCK_TABS_KEY = "pi-web:aiti-cmd:terminal-dock";
  const saveTabAttached = () => { try { sessionStorage.setItem(DOCK_TABS_KEY, JSON.stringify(tabAttached)); } catch {} };
  try {
    const saved = JSON.parse(sessionStorage.getItem(DOCK_TABS_KEY) || "null");
    if (saved && typeof saved === "object") for (const [tid, e] of Object.entries(saved)) if (e && e.sessionId) tabAttached[tid] = e;
    // orphan cleanup: tab ids the host no longer restores (closed while cleanup did not run)
    const hostTabs = JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") || "null");
    const hostIds = new Set(((hostTabs && Array.isArray(hostTabs.tabs)) || []).map((x) => x && x.id).filter(Boolean));
    for (const tid of Object.keys(tabAttached)) if (!hostIds.has(tid)) delete tabAttached[tid];
  } catch {}

  // single entry point for entry add/remove (memory + persistence + notify); `detached` is
  // memory-only view ownership — after a refresh everything returns to "tab owns it"
  function setTabEntry(tabId, entry) { tabAttached[tabId] = entry; delete tabDetached[tabId]; saveTabAttached(); notifyTabAttached(); }
  function clearTabEntry(tabId) { if (!(tabId in tabAttached) && !(tabId in tabDetached)) return; delete tabAttached[tabId]; delete tabDetached[tabId]; saveTabAttached(); notifyTabAttached(); }
  // non-hook variant: is the session currently owned by a tab (badge in the running list)?
  function sessionHostTabSync(sessionId) { for (const [tid, e] of Object.entries(tabAttached)) if (e && e.sessionId === sessionId && tabDetached[tid] !== true) return tid; return null; }
  // pending takeovers: the dialog pushes → openShellTab creates a tab → the new tab's effect
  // consumes it by cwd and binds the existing session (no new shell). TTL guards stale entries.
  const pendingTakeovers = []; // { cwd, sessionId, title, ts }
  const PENDING_TAKEOVER_TTL = 15000;

  function useTabAttachedState(tabId) {
    const [v, setV] = useState(() => ({ entry: tabAttached[tabId] || null, detached: tabDetached[tabId] === true }));
    useEffect(() => {
      const l = () => setV({ entry: tabAttached[tabId] || null, detached: tabDetached[tabId] === true });
      tabAttachedListeners.add(l);
      l();
      return () => tabAttachedListeners.delete(l);
    }, [tabId]);
    return v;
  }
  // dialog side: is this PTY session owned by a tab (not detached)? → render the placeholder
  function useSessionHostTab(sessionId) {
    const [hostTabId, setHostTabId] = useState(() => sessionHostTabSync(sessionId));
    useEffect(() => {
      const l = () => setHostTabId(sessionHostTabSync(sessionId));
      l(); // evaluate immediately when sessionId changes (enter detail) — do not wait for an ownership event
      tabAttachedListeners.add(l);
      return () => tabAttachedListeners.delete(l);
    }, [sessionId]);
    return hostTabId;
  }

  // tab-only shell creation (same /shell backend call; no dialog, no view switch — ownership is the caller's)
  async function createShellSession(cwd) {
    const r = await fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cwd || undefined, name: "bash" }) }).then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }));
    if (!r || !r.ok || !r.sessionId) throw new Error((r && r.error) || t("cmd.k122"));
    return { sessionId: r.sessionId, title: r.name || "bash" };
  }

  /**
   * Dialog → workspace tab ("⇱ 转到页签"):
   * · the session is already bound to a tab (incl. the pulled-back state) → hand ownership back;
   * · never bound → host pi-web.ui onOpenTerminal(cwd, true) creates a tab, pendingTakeovers
   *   binds it to the existing session (no new shell), then the dialog closes.
   * @returns {{ok:boolean, error?:string}}
   */
  function sendToTab(session) {
    if (!session) return { ok: false, error: t("cmd.k363") };
    for (const [tid, e] of Object.entries(tabAttached)) {
      if (e && e.sessionId === session.id) {
        tabDetached[tid] = false;
        notifyTabAttached();
        return { ok: true };
      }
    }
    const cwd = session.cwd || "";
    if (!cwd) return { ok: false, error: t("cmd.k363") };
    const openTab = kit.ctx?.getExtService?.("pi-web.ui")?.get?.("onOpenTerminal");
    if (typeof openTab !== "function") return { ok: false, error: t("cmd.k362") };
    pendingTakeovers.push({ cwd, sessionId: session.id, title: session.name || session.cmd || "bash", ts: Date.now() });
    try { openTab(cwd, true); } catch (e) {
      pendingTakeovers.pop();
      return { ok: false, error: t("cmd.k361") + ((e instanceof Error && e.message) || String(e)) };
    }
    return { ok: true };
  }

  // workspace terminal tab host (terminalDock slot render): real takeover, renders the terminal inline.
  // openShellTab: host callback (TerminalPanelBridge) — "＋ new" opens another shell tab at the same cwd.
  function WorkspaceTerminalHost({ cwd, tabId, active, restored, onClosed, openShellTab }) {
    const attached = useTabAttachedState(tabId);
    const triedRef = useRef(false);
    const attachingRef = useRef(false); // same-tick double-click guard (state updates are async)
    const [attaching, setAttaching] = useState(false);
    const [error, setError] = useState(null);
    // The host owns the shell's light/dark choice (lib/terminal-theme.ts). Mirroring it on the
    // root element lets the host's --terminal-* variables paint this takeover surface too.
    const [termTheme, setTermThemeState] = useState(readTermTheme);
    useEffect(() => subscribeTermTheme(setTermThemeState), []);
    const attach = async () => {
      if (attachingRef.current) return;
      attachingRef.current = true;
      setAttaching(true);
      setError(null);
      try {
        const entry = await createShellSession(cwd);
        setTabEntry(tabId, entry);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        attachingRef.current = false;
        setAttaching(false);
      }
    };
    /** Consume a dialog "move to tab" request for this tab (true when a session was bound). */
    const consumePendingTakeover = () => {
      const now = Date.now();
      for (let i = 0; i < pendingTakeovers.length; i++) {
        if (now - pendingTakeovers[i].ts >= PENDING_TAKEOVER_TTL) { pendingTakeovers.splice(i, 1); i--; }
      }
      // match by cwd; the host may normalize the path (trailing slash, resolved workspace root),
      // so a single fresh pending entry is unambiguously ours (the tab was just created for it)
      let pIdx = pendingTakeovers.findIndex((p) => p.cwd === cwd || String(p.cwd).replace(/\/+$/, "") === String(cwd || "").replace(/\/+$/, ""));
      if (pIdx < 0) {
        const fresh = pendingTakeovers.map((p, i) => ({ p, i })).filter(({ p }) => now - p.ts < PENDING_TAKEOVER_TTL);
        if (fresh.length === 1) pIdx = fresh[0].i;
      }
      if (pIdx < 0) return false;
      const p = pendingTakeovers.splice(pIdx, 1)[0];
      setTabEntry(tabId, { sessionId: p.sessionId, title: p.title, cwd });
      return true;
    };
    // ⓪ "move to tab" creates a tab that the host may still report as inactive — bind the pending
    // session right away so ownership transfers without a manual click.
    useEffect(() => {
      if (triedRef.current) return;
      if (consumePendingTakeover()) triedRef.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // first activation takes over, three paths: ① a dialog "move to tab" pending takeover;
    // ② liveness check of a restored binding; ③ no binding → create (restored tabs show the button).
    useEffect(() => {
      if (!active || triedRef.current) return;
      if (consumePendingTakeover()) { triedRef.current = true; return; }
      // ② restored binding: check the session once — alive/exited both stay; 404 clears the binding
      if (attached.entry && !attached.detached) {
        triedRef.current = true;
        const sid = attached.entry.sessionId;
        fetch(api("/sessions/" + sid)).then((r) => (r.ok ? r.json() : null)).then((d) => {
          if (d && d.ok && (d.status === "running" || d.status === "queued" || d.status === "exit")) return;
          clearTabEntry(tabId);
        }).catch(() => {}); // network hiccup: keep the binding, TerminalView reconnects on its own
        return;
      }
      // ③ no binding: a fresh tab auto-starts a shell; a restored tab shows the button instead
      if (restored || attached.entry || attachingRef.current) return;
      triedRef.current = true;
      void attach();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, restored, attached.entry]);
    // tab close: the host unmounts us → cleanup releases the binding (the shell survives)
    // Tab close → release the binding. The host may also remount this component while the tab
    // stays open (new element identity per dock render), so a plain unmount cleanup would wipe a
    // just-transferred session. Count mounts and only release when no instance comes back.
    useEffect(() => {
      mountCounts.set(tabId, (mountCounts.get(tabId) || 0) + 1);
      return () => {
        const left = (mountCounts.get(tabId) || 1) - 1;
        if (left > 0) { mountCounts.set(tabId, left); return; }
        mountCounts.set(tabId, 0);
        setTimeout(() => {
          if ((mountCounts.get(tabId) || 0) > 0) return; // remounted: keep the binding
          clearTabEntry(tabId);
        }, 400);
      };
    }, [tabId]);

    const detachedEntry = attached.entry && attached.detached;
    // pull back into the window: hand ownership to the dialog and open that session
    const pullBackToPanel = () => {
      if (!attached.entry) return;
      tabDetached[tabId] = true;
      notifyTabAttached();
      store.set({ detail: null });
      store.openApp("terminal", { sessionId: attached.entry.sessionId, title: attached.entry.title });
    };
    // takeover back to the tab: ownership returns (the dialog side turns into a placeholder)
    const takeBackToTab = () => {
      tabDetached[tabId] = false;
      notifyTabAttached();
    };

    let body;
    if (!attached.entry) {
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 } },
        h("div", { title: cwd, style: { display: "flex", alignItems: "center", gap: 6, maxWidth: "100%", overflow: "hidden", color: "var(--text-muted)" } },
          h("span", { style: { display: "inline-flex", flexShrink: 0 } }, Ic(14, ICONS.monitor)),
          h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, cwd),
        ),
        attaching ? h("span", null, t("cmd.k295"))
        : h("button", { onClick: attach, style: { ...btnStyle, padding: "6px 14px", background: "var(--bg-hover)", borderColor: "var(--border)", color: "var(--accent)", fontWeight: 600, fontSize: 12 } },
            t("cmd.k240"),
          ),
        error && h("span", { role: "alert", style: { color: "var(--danger, #ef4444)" } }, error),
        h("span", { style: { fontSize: 11, color: "var(--text-muted)" } }, t("cmd.k49")),
      );
    } else if (detachedEntry) {
      // pulled back into the window: the tab shows a placeholder (single instance)
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, color: "var(--text-dim)", fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" } },
          h("span", { style: { display: "inline-flex", flexShrink: 0 } }, Ic(14, ICONS.monitor)),
          h("span", null, attached.entry.title + t("cmd.k15")),
        ),
        h("button", { onClick: takeBackToTab, style: { ...btnStyle, padding: "6px 14px", color: "var(--accent)", fontWeight: 600, fontSize: 12 } }, t("cmd.k240")),
        h("span", { style: { fontSize: 11, color: "var(--text-muted)" } }, t("cmd.k328")),
      );
    } else {
      // no separate header row (double title bar collapsed): actions live in the TerminalView toolbar
      body = h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" } },
        h(TerminalView, {
          sessionId: attached.entry.sessionId,
          height: "100%",
          onExit: () => clearTabEntry(tabId),
          pullBack: pullBackToPanel,
          // "＋ new" at the terminal's live pwd (check first, then open another tab)
          onNewShell: typeof openShellTab === "function" && attached.entry ? () => { void liveCwdOf(attached.entry.sessionId, cwd).then((live) => openShellTab(live || cwd)); } : undefined,
          // "💬 new session": a pi-web session @ the same live path (host channel)
          onNewPiSession: attached.entry ? () => { void liveCwdOf(attached.entry.sessionId, cwd).then((live) => { openNewPiSession(live || cwd); }); } : undefined,
        }),
      );
    }
    return h("div", { "data-terminal-theme": termTheme, style: { height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--terminal-bg, #111318)" } }, body);
  }

  /** Dialog ⇲ "pull back into the window": hand the view back from the tab (tab shows a placeholder). */
  function detachToDialog(sessionId) {
    const tid = sessionHostTabSync(sessionId);
    if (!tid) return false;
    tabDetached[tid] = true;
    notifyTabAttached();
    return true;
  }

  return { WorkspaceTerminalHost, useSessionHostTab, sessionHostTabSync, sendToTab, detachToDialog, setTabEntry, clearTabEntry, pendingTakeovers };
}

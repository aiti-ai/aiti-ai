/**
 * aiti-cmd client · composerTools entry — always-visible run-status button.
 *
 * Lives in the host's `composerTools` slot (desktop: the icon row under the input box,
 * next to compact/import/ops-timeline; mobile: the bottom action area of the ＋ sheet —
 * the host renders the same slot in both places, so one registration covers both).
 *
 * Live count comes from the event bus (cmd-sessions / cmd-pilist) with the keepalive
 * protocol; clicking opens the running app on the "running" filter.
 */
export function createRunningEntry(kit, store) {
  const { h, t, api, Ic, ICONS, useState, useEffect } = kit;

  return function RunningEntry() {
    const [count, setCount] = useState(0);
    const [hover, setHover] = useState(false);
    useEffect(() => {
      const apply = (sessions, pi) => {
        const pty = (sessions || []).filter((s) => s.status === "running" || s.status === "queued").length;
        const agent = (pi || []).filter((c) => c.status === "running").length;
        setCount(pty + agent);
      };
      const pull = () => {
        fetch(api("/sessions")).then((r) => r.json()).then((d) => apply(d.sessions, null)).catch(() => {});
        fetch(api("/pi-commands")).then((r) => r.json()).then((d) => apply(null, d.commands)).catch(() => {});
      };
      pull();
      const sub = kit.ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
      if (!sub) return;
      const s = sub((f) => {
        if (f.evt === "sessions") apply(f.sessions || [], null);
        else if (f.evt === "pilist") apply(null, f.commands || []);
      }, ["cmd-sessions", "cmd-pilist"]);
      kit.aliveAdd("cmd-sessions", "cmd-pilist");
      return () => { try { s.off(); } catch {} kit.aliveDel("cmd-sessions", "cmd-pilist"); };
    }, []);
    const active = count > 0;
    return h("button", {
      type: "button",
      onClick: () => store.openApp("running", { filter: "live" }),
      title: t("cmd.app.entry.title") + (active ? " · " + count : ""),
      "aria-label": t("cmd.app.entry.title"),
      style: {
        position: "relative", display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        width: 32, height: 32, padding: 0, background: hover ? "var(--bg-hover)" : "none",
        border: "none", borderRadius: 9, cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-muted)",
        transition: "background 0.12s, color 0.12s",
      },
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
      Ic(15, ICONS.terminal),
      active && h("span", {
        style: {
          position: "absolute", top: 1, right: 0, minWidth: 13, height: 13, padding: "0 3px",
          borderRadius: 999, background: "var(--accent)", color: "#fff",
          fontSize: 9, lineHeight: "13px", fontWeight: 700, textAlign: "center",
        },
      }, count > 99 ? "99+" : String(count)),
    );
  };
}

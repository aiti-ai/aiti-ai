/**
 * aiti-cmd client · PiCommandView — read-only live output of an agent bash command.
 *
 * Belongs to the running app (agent commands are not terminals: no stdin). Moved verbatim
 * from the old single-file client; ctx-bound identifiers come from the kit.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { btnStyle, smallStyle, TERM_THEME, TERM_FONT, installTermLinkProvider, installTermClipboard } from "../kit.js";
import { TermLinkConfirm } from "./terminal-view.js";

export function createPiCommandView(kit) {
  const { h, t, api, useRef, useState, useEffect, useIsZh, aliveAdd, aliveDel } = kit;

  return function PiCommandView({ cmdId, counts, onSaveCommand }) {
    const isZh = useIsZh();
    const ref = useRef(null);
    const [status, setStatus] = useState("connecting");
    const [meta, setMeta] = useState(null);
    const [exitInfo, setExitInfo] = useState(null);
    const [hasSel, setHasSel] = useState(false);
    const [linkConfirm, setLinkConfirm] = useState(null);
    const termRef = useRef(null);
    const [killBusy, setKillBusy] = useState(false);
    const [fs, setFs] = useState(false); // fullscreen
    // small-screen breakpoint (max-width: 640px) — height changes (IME) never flip the layout
    const [isSmall, setIsSmall] = useState(() => typeof window !== "undefined" && (window.matchMedia ? (window.matchMedia("(max-width: 640px)").matches) : false));
    useEffect(() => {
      if (typeof window === "undefined" || !window.matchMedia) return;
      const mq = window.matchMedia("(max-width: 640px)");
      const onChange = () => setIsSmall(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }, []);
    useEffect(() => {
      if (!ref.current) return;
      // read-only terminal: the agent's bash has no stdin — disableStdin also avoids focus stealing
      const term = new Terminal({ fontFamily: TERM_FONT, fontSize: 13, scrollback: 2000, convertEol: false, rendererType: "dom", cursorBlink: false, disableStdin: true, theme: TERM_THEME });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      termRef.current = term;
      try { fit.fit(); } catch {}
      // link detection: clickable URLs → confirmation overlay → new window
      const linkDisp = installTermLinkProvider(term, (uri) => setLinkConfirm({ uri }));
      // ---------- downlink: the event-bus topic cmd-<cmdId> is the only live channel (no fallbacks) ----------
      // The initial full text (≤512KB) does not go over the bus: once subscribed we pull
      // /pi-commands/{id} (text = published baseline + seq), reset + seq de-dupe.
      let busOff = null;
      let seenSeq = -1;
      let exited = false;
      let everDown = false;
      let disposed = false;
      let currentCmd = "";
      let headerWritten = false;
      // idempotent header: xterm writes are queued while reset is synchronous — writing the header
      // from both `started` and `replace` would leave a duplicate; write it lazily before real output.
      const ensureHeader = () => { if (!headerWritten) { headerWritten = true; try { term.write(`\x1b[94m$ ${currentCmd || "（订阅前已开始）"}\x1b[0m\r\n`); } catch {} } };
      // exit banner (terminated/error → red, clean → green)
      const writeExitBanner = (m) => {
        const tail = `${t("cmd.k337")}${((m.durationMs || 0) / 1000).toFixed(1)}s${m.truncated ? " · 输出已截断" : ""}`;
        if (m.isError) term.write(`\r\n\x1b[41;97m ⏹ 命令已停止（出错/被终止） · ${tail} \x1b[0m\r\n`);
        else term.write(`\r\n\x1b[42;30m ✓ 命令已完成 · ${tail} \x1b[0m\r\n`);
      };
      const hideCursor = () => { try { term.write("\x1b[?25l"); } catch {} };
      const applyFrame = (m) => {
        if (m.evt === "started") { setStatus(m.status === "running" ? "running" : "exit"); setMeta(m); currentCmd = String(m.cmd || ""); }
        else if (m.evt === "replace") {
          if (typeof m.seq === "number") { if (m.seq <= seenSeq) return; seenSeq = m.seq; }
          try { term.reset(); } catch {} headerWritten = false; ensureHeader(); term.write(m.data || ""); try { term.scrollToBottom(); } catch {}
        }
        else if (m.evt === "data") {
          if (exited) return; // no frames after exit (prevents old output bleeding past the banner)
          if (typeof m.seq === "number") { if (m.seq <= seenSeq) return; seenSeq = m.seq; }
          ensureHeader(); term.write(m.data || ""); try { term.scrollToBottom(); } catch {} setStatus("running");
        }
        else if (m.evt === "exit") {
          if (exited) return;
          exited = true;
          ensureHeader();
          setStatus("exit"); setExitInfo(m);
          hideCursor();
          writeExitBanner(m);
          busOff?.(); busOff = null; aliveDel("cmd-" + cmdId);
        }
      };
      const applySnapshot = (d) => {
        if (!d || !d.ok) return;
        setStatus(d.status === "done" ? "exit" : "running");
        setMeta({ sessionId: d.sessionId, cmd: d.cmd, cwd: d.cwd }); // explicit fields: never store the big text in state
        currentCmd = String(d.cmd || "");
        try { term.reset(); } catch {} headerWritten = false; ensureHeader();
        if (d.text) term.write(d.text);
        try { term.scrollToBottom(); } catch {}
        if (typeof d.seq === "number" && d.seq > seenSeq) seenSeq = d.seq;
        if (d.status === "done") {
          hideCursor();
          writeExitBanner(d); // re-write after reset (the flag is already set)
          if (!exited) { exited = true; setExitInfo({ isError: d.isError, durationMs: d.durationMs, truncated: d.truncated }); }
        }
      };
      // subscribe first, then pull the full snapshot once ready (overlap de-duped by seq)
      const setupLive = () => {
        if (exited || disposed) return;
        const topicsSub = kit.ctx?.getExtService?.("aiti-event-bus.subscribe-topics");
        if (!topicsSub) return;
        const pullSnap = () => { fetch(api(`/pi-commands/${cmdId}`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {}); };
        const sub = topicsSub(applyFrame, ["cmd-" + cmdId], (s) => {
          if (s === "reconnecting") { everDown = true; setStatus("reconnecting"); }
          else if (s === "up") {
            setStatus((prev) => (prev === "reconnecting" ? "running" : prev));
            if (everDown && !exited) {
              everDown = false;
              pullSnap();
            }
          }
        });
        busOff = () => { try { sub.off(); } catch {} };
        aliveAdd("cmd-" + cmdId);
        sub.ready.then(pullSnap).catch(() => {
          // bus unreachable: still pull one snapshot (no live stream, content visible)
          pullSnap();
        });
      };
      // init: cheap meta probe first (?meta=1 has no text) —
      // done → one full snapshot, no subscription/keepalive; running → subscribe first; probe failure → live path
      fetch(api(`/pi-commands/${cmdId}?meta=1`)).then((r) => r.json()).then((info) => {
        if (disposed) return;
        if (info && info.ok) {
          if (info.status === "done") {
            setMeta(info);
            setStatus("exit");
            fetch(api(`/pi-commands/${cmdId}`)).then((r) => r.json()).then((d) => { if (!disposed) applySnapshot(d); }).catch(() => {});
            return;
          }
          setMeta((prev) => ({ ...(prev || {}), ...info }));
        }
        setupLive();
      }).catch(() => setupLive());
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { try { fit.fit(); } catch {} }) : null;
      if (ro) ro.observe(ref.current);
      // the read-only view can still copy: right-click / Ctrl+Shift+C / Ctrl+Insert (no paste — no stdin)
      const clip = installTermClipboard(term, ref.current);
      term.attachCustomKeyEventHandler((ev) => !clip.handleKey(ev));
      term.onSelectionChange(() => { try { setHasSel(!!term.getSelection()); } catch {} });
      return () => { disposed = true; busOff?.(); aliveDel("cmd-" + cmdId); linkDisp?.dispose?.(); clip.dispose(); ro?.disconnect(); term.dispose(); termRef.current = null; };
    }, [cmdId]);
    const killPi = () => {
      if (killBusy) return;
      setKillBusy(true);
      // immediate in-terminal hint (do not wait for the bus frame)
      try { termRef.current?.write?.("\r\n\x1b[90m[已发送终止信号（SIGTERM），等待进程退出…]\x1b[0m\r\n"); } catch {}
      fetch(api(`/pi-commands/${cmdId}/kill`), { method: "POST" }).catch(() => {}).finally(() => {
        setTimeout(() => setKillBusy(false), 1500); // minimum visible state, prevents flicker
      });
    };
    // save the command: selection first (partial is fine), else the full command → command detail card
    const saveCmd = () => {
      try {
        const sel = termRef.current?.getSelection?.().trim();
        const cmd = sel || String(meta?.cmd || "").trim();
        if (!cmd) return;
        onSaveCommand?.({ cmd, cwd: meta?.cwd || null });
      } catch {}
    };
    const scrollBottom = () => {
      try { const c = ref.current; if (c) c.scrollTop = c.scrollHeight; } catch {}
      try { termRef.current?.scrollToBottom(); } catch {}
    };
    return h("div", { style: fs ? { position: "fixed", inset: 0, zIndex: 500, background: "var(--bg-panel)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, boxSizing: "border-box" } : { display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 } },
      h("div", { style: { ...smallStyle, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        status === "exit" ? h("span", { style: { display: "inline-flex", alignItems: "center", flexShrink: 0, padding: "1px 8px", borderRadius: 6, fontWeight: 700, fontSize: 11, lineHeight: "16px", color: exitInfo?.swept ? "var(--text)" : exitInfo?.isError ? "#fff" : "var(--ok, #4ade80)", background: exitInfo?.swept ? "var(--bg-hover)" : exitInfo?.isError ? "var(--danger, #ef4444)" : "color-mix(in srgb, var(--ok, #4ade80) 18%, transparent)" } },
          isSmall
            ? (exitInfo?.swept ? t("cmd.k203") : exitInfo?.isError ? t("cmd.k198") : t("cmd.k189"))
            : (exitInfo?.swept ? t("cmd.k204") : exitInfo?.isError ? t("cmd.k173") : t("cmd.k174")))
        : h("span", { style: { color: status === "running" ? "var(--ok, #4ade80)" : "var(--text)" } },
          isSmall
            ? (status === "running" ? "●" : status === "reconnecting" ? "⚠" : "…")
            : (status === "running" ? t("cmd.k60") : status === "reconnecting" ? t("cmd.k382") : t("cmd.k51"))),
        !isSmall && meta && h("code", { style: smallStyle }, "🤖 " + String(meta.sessionId || "").slice(0, 8) + " $ " + String(meta.cmd || t("cmd.k399")).slice(0, 70)),
        h("button", { onClick: saveCmd, disabled: !hasSel && !String(meta?.cmd || "").trim(), title: hasSel ? t("cmd.k252") : t("cmd.k250"), "aria-label": t("cmd.k249"), style: { ...btnStyle, padding: isSmall ? "2px 6px" : "2px 10px", opacity: hasSel || String(meta?.cmd || "").trim() ? 1 : 0.5, cursor: hasSel || String(meta?.cmd || "").trim() ? "pointer" : "not-allowed" } }, isSmall ? "＋" : t("cmd.k401")),
        exitInfo && !isSmall && !exitInfo.swept && h("span", { style: { fontWeight: 700, color: exitInfo.isError ? "var(--danger, #ef4444)" : "var(--text-muted)" } }, (exitInfo.isError ? t("cmd.k115") : t("cmd.k189")) + " · " + ((exitInfo.durationMs || 0) / 1000).toFixed(1) + "s"),
        status !== "exit" && h("button", { onClick: killPi, disabled: killBusy, title: killBusy ? t("cmd.k322") : t("cmd.k158"), "aria-label": t("cmd.k323"), style: { ...btnStyle, color: "var(--danger, #ef4444)", padding: isSmall ? "2px 6px" : "2px 10px", opacity: killBusy ? 0.6 : 1, cursor: killBusy ? "wait" : "pointer" } }, killBusy ? (isSmall ? "⏳" : t("cmd.k320")) : (isSmall ? "⏹" : t("cmd.k323"))),
        h("button", { onClick: scrollBottom, title: t("cmd.k302"), "aria-label": t("cmd.k302"), style: { ...btnStyle, padding: "2px 8px" } }, isZh ? t("cmd.k54") : "⇊"),
        h("button", { onClick: () => setFs((x) => !x), title: t("cmd.k102"), "aria-label": t("cmd.k101"), style: { ...btnStyle, padding: "2px 8px", color: fs ? "var(--accent)" : undefined } }, fs ? "⤡" : "⛶"),
      ),
      h("div", { ref, style: { flex: 1, minHeight: 0, background: "#0f172a", borderRadius: 8, padding: 6, overflow: "hidden" } }),
      // small screens: bottom status bar (meta is always present here)
      isSmall && meta && h("div", { style: { flexShrink: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", padding: "4px 6px 0", overflow: "hidden", minHeight: 0, whiteSpace: "nowrap" } },
        counts && h("span", { title: t("cmd.k217"), style: { flexShrink: 0 } }, "🤖" + counts.piRunning + "/" + counts.piTotal + " 🖥" + counts.ptyRunning),
        h("span", { title: t("cmd.k39"), style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 } }, "🤖 " + String(meta.sessionId || "").slice(0, 8)),
        h("code", { title: String(meta.cmd), style: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 2, color: "var(--text)" } }, "$ " + String(meta.cmd || t("cmd.k399")).slice(0, 60)),
        exitInfo && h("span", { style: { color: exitInfo.isError ? "var(--danger, #ef4444)" : "var(--text-muted)", flexShrink: 0 } }, exitInfo.swept ? t("cmd.k202") : (exitInfo.isError ? "⚠ " : "✓ ") + ((exitInfo.durationMs || 0) / 1000).toFixed(1) + "s"),
      ),
      h(TermLinkConfirm, { h, t, link: linkConfirm, onClose: () => setLinkConfirm(null) }),
    );
  };
}
